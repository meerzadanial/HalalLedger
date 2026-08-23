import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import type { EmailProviderCommand } from "./provider";
import {
  ResendEmailProvider,
  type ResendClient,
} from "./resendEmailProvider";

const NOW = new Date("2025-01-15T10:20:30.000Z");
const EVENT_ID = "evt_123";
const MESSAGE_ID = "msg_456";
const SIGNING_KEY = Buffer.from("01234567890123456789012345678901", "utf8");
const WEBHOOK_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;

const command: EmailProviderCommand = {
  idempotencyKey: "report:11111111-1111-4111-8111-111111111111",
  to: ["driver@example.com"],
  subject: "Weekly Report: 2025-01-06 to 2025-01-12",
  textBody: "Report Type: weekly",
  attachment: {
    filename: "weekly_2025-01-06_2025-01-12.csv",
    mediaType: "text/csv; charset=UTF-8",
    bytes: new Uint8Array(Buffer.from("name,amount\r\nCafé,1.00\r\n")),
  },
};

function makeProvider(
  sendResult: unknown = { data: { id: MESSAGE_ID }, error: null },
) {
  const send = vi.fn(async () => sendResult) as ResendClient["emails"]["send"];
  const client: ResendClient = { emails: { send } };
  const clock: Clock = { now: () => new Date(NOW) };
  const provider = new ResendEmailProvider(
    {
      apiKey: "re_test_key",
      webhookSecret: WEBHOOK_SECRET,
      fromEmail: "Reports <reports@example.com>",
    },
    { client, clock },
  );
  return { provider, send };
}

function eventBody(type: string, overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(JSON.stringify({
    type,
    created_at: "2025-01-15T10:20:29.125Z",
    data: { email_id: MESSAGE_ID },
    ...overrides,
  }), "utf8");
}

function signedHeaders(
  body: Buffer,
  timestamp = String(Math.floor(NOW.getTime() / 1_000)),
) {
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(Buffer.concat([
      Buffer.from(`${EVENT_ID}.${timestamp}.`, "utf8"),
      body,
    ]))
    .digest("base64");
  return {
    "svix-id": EVENT_ID,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

describe("ResendEmailProvider", () => {
  it("submits exactly one recipient and attachment with the stable key", async () => {
    const { provider, send } = makeProvider();

    const acceptance = await provider.submit(command);

    expect(acceptance).toEqual({
      providerMessageId: MESSAGE_ID,
      acceptedAt: NOW,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(
      {
        from: "Reports <reports@example.com>",
        to: ["driver@example.com"],
        subject: command.subject,
        text: command.textBody,
        attachments: [{
          filename: command.attachment.filename,
          contentType: "text/csv; charset=UTF-8",
          content: Buffer.from(command.attachment.bytes),
        }],
      },
      { idempotencyKey: command.idempotencyKey },
    );
  });

  it.each([
    ["invalid_parameter", "rejected", true],
    ["rate_limit_exceeded", "unavailable", false],
    ["new_provider_error", "invalid_response", false],
  ])(
    "classifies Resend error %s as %s",
    async (name, kind, definitive) => {
      const { provider } = makeProvider({
        data: null,
        error: { name, message: "provider detail must not escape" },
      });

      let caught: unknown;
      try {
        await provider.submit(command);
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        name: "EmailProviderSubmissionError",
        message: "Email provider submission failed.",
        kind,
        definitive,
      });
      expect(JSON.stringify(caught)).not.toContain("provider detail");
    },
  );

  it("classifies transport failures and malformed success responses as retryable", async () => {
    const unavailable = makeProvider();
    unavailable.send.mockRejectedValueOnce(new Error("api-key=secret"));
    await expect(unavailable.provider.submit(command)).rejects.toMatchObject({
      kind: "unavailable",
      definitive: false,
    });

    const invalid = makeProvider({ data: { id: "" }, error: null });
    await expect(invalid.provider.submit(command)).rejects.toMatchObject({
      kind: "invalid_response",
      definitive: false,
    });
  });

  it.each([
    ["email.delivered", "delivered"],
    ["email.failed", "failed"],
    ["email.bounced", "bounced"],
    ["email.suppressed", "suppressed"],
  ])("verifies and maps %s", (providerType, eventType) => {
    const { provider } = makeProvider();
    const body = eventBody(providerType);

    const event = provider.verifyWebhook(body, signedHeaders(body));

    expect(event).toEqual({
      providerEventId: EVENT_ID,
      providerMessageId: MESSAGE_ID,
      eventType,
      occurredAt: new Date("2025-01-15T10:20:29.125Z"),
      payloadDigest: createHash("sha256").update(body).digest("hex"),
    });
    expect(Object.keys(event).sort()).toEqual([
      "eventType",
      "occurredAt",
      "payloadDigest",
      "providerEventId",
      "providerMessageId",
    ]);
    expect(JSON.stringify(event)).not.toContain(WEBHOOK_SECRET);
    expect(JSON.stringify(event)).not.toContain(body.toString("utf8"));
  });

  it("verifies the exact unmodified payload and rejects modified or stale input", () => {
    const { provider } = makeProvider();
    const body = Buffer.from(
      `{\n  "type": "email.delivered",\n  "created_at": "2025-01-15T10:20:29.125Z",\n  "data": { "email_id": "${MESSAGE_ID}", "label": "café" }\n}`,
      "utf8",
    );
    const headers = signedHeaders(body);

    expect(provider.verifyWebhook(body, headers).eventType).toBe("delivered");
    expect(() => provider.verifyWebhook(Buffer.concat([body, Buffer.from(" ")]), headers))
      .toThrow(expect.objectContaining({ code: "invalid_provider_signature" }));
    expect(() => provider.verifyWebhook(body, {
      ...headers,
      "svix-timestamp": String(Math.floor(NOW.getTime() / 1_000) - 301),
    })).toThrow(expect.objectContaining({ code: "invalid_provider_signature" }));
    expect(() => provider.verifyWebhook(body, {
      "svix-id": EVENT_ID,
      "svix-timestamp": headers["svix-timestamp"],
    })).toThrow(expect.objectContaining({ code: "invalid_provider_signature" }));
  });

  it("returns a safe typed error for signed malformed or unsupported events", () => {
    const { provider } = makeProvider();
    const malformed = eventBody("email.failed", { data: {} });
    const unsupported = eventBody("email.opened");

    expect(() => provider.verifyWebhook(malformed, signedHeaders(malformed)))
      .toThrow(expect.objectContaining({
        code: "malformed_provider_event",
        message: "Provider webhook event is malformed.",
      }));
    expect(() => provider.verifyWebhook(unsupported, signedHeaders(unsupported)))
      .toThrow(expect.objectContaining({ code: "malformed_provider_event" }));
  });
});