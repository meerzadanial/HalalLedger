import { createHmac } from "node:crypto";
import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import {
  ReportDomainError,
  ResendEmailProvider,
  type Clock,
  type VerifiedProviderEvent,
} from "../reporting";
import {
  createResendWebhookRouter,
  type ResendWebhookServices,
} from "./resendWebhook";

const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";
const RAW_BODY = '{"type":"email.delivered","data":{"email_id":"message-1"}}';
const SIGNED_NOW = new Date("2025-01-15T10:20:30.000Z");
const SIGNING_KEY = Buffer.from("local-test-signing-key-32-bytes!!", "utf8");
const WEBHOOK_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;
const SIGNED_RAW_BODY = `{
  "type": "email.delivered",
  "created_at": "2025-01-15T10:20:29.125Z",
  "data": { "email_id": "message-1", "label": "café" }
}`;
const verifiedEvent: VerifiedProviderEvent = {
  providerEventId: "event-1",
  providerMessageId: "message-1",
  eventType: "delivered",
  occurredAt: new Date("2025-01-15T10:04:00.000Z"),
  payloadDigest: "a".repeat(64),
};

function makeHarness() {
  const provider = { verifyWebhook: vi.fn().mockReturnValue(verifiedEvent) };
  const processor = {
    process: vi.fn().mockResolvedValue({
      disposition: "stored",
      outcome: "sent",
    }),
  };
  const services: ResendWebhookServices = { provider, processor };
  const app = express();
  app.use(
    "/api/webhooks/resend",
    createResendWebhookRouter({
      getServices: () => services,
      generateCorrelationId: () => CORRELATION_ID,
    }),
  );
  app.use(express.json());
  app.post("/api/after-webhook", (req, res) => res.json(req.body));
  return { app, provider, processor };
}

function signedHeaders(rawBody: string, eventId = "event-signed") {
  const timestamp = String(Math.floor(SIGNED_NOW.getTime() / 1_000));
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(Buffer.concat([
      Buffer.from(`${eventId}.${timestamp}.`, "utf8"),
      Buffer.from(rawBody, "utf8"),
    ]))
    .digest("base64");
  return {
    "svix-id": eventId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function makeSignedHarness() {
  const clock: Clock = { now: () => new Date(SIGNED_NOW) };
  const provider = new ResendEmailProvider(
    {
      apiKey: "re_local_test_key",
      webhookSecret: WEBHOOK_SECRET,
      fromEmail: "Reports <reports@example.com>",
    },
    {
      clock,
      client: { emails: { send: vi.fn() } },
    },
  );
  const processor = {
    process: vi.fn().mockResolvedValue({
      disposition: "stored",
      outcome: "sent",
    }),
  };
  const app = express();
  app.use(
    "/api/webhooks/resend",
    createResendWebhookRouter({
      getServices: () => ({ provider, processor }),
      generateCorrelationId: () => CORRELATION_ID,
    }),
  );
  app.use(express.json());
  return { app, processor };
}

function webhook(app: express.Express) {
  return request(app)
    .post("/api/webhooks/resend")
    .set("content-type", "application/json")
    .set("svix-id", "event-1")
    .set("svix-timestamp", "1736935440")
    .set("svix-signature", "v1,signature")
    .send(RAW_BODY);
}

describe("Resend webhook route", () => {
  it("verifies the exact raw body before durable processing", async () => {
    const { app, provider, processor } = makeHarness();
    const response = await webhook(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });
    expect(Buffer.isBuffer(provider.verifyWebhook.mock.calls[0][0])).toBe(true);
    expect(provider.verifyWebhook.mock.calls[0][0].toString("utf8")).toBe(RAW_BODY);
    expect(processor.process).toHaveBeenCalledWith(verifiedEvent);

    const jsonResponse = await request(app)
      .post("/api/after-webhook")
      .send({ still: "parsed" });
    expect(jsonResponse.body).toEqual({ still: "parsed" });
  });

  it("accepts a locally signed fixture using the exact route-captured bytes", async () => {
    const { app, processor } = makeSignedHarness();

    const response = await request(app)
      .post("/api/webhooks/resend")
      .set("content-type", "application/json")
      .set(signedHeaders(SIGNED_RAW_BODY))
      .send(SIGNED_RAW_BODY);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: false });
    expect(processor.process).toHaveBeenCalledWith(expect.objectContaining({
      providerEventId: "event-signed",
      providerMessageId: "message-1",
      eventType: "delivered",
      occurredAt: new Date("2025-01-15T10:20:29.125Z"),
      payloadDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
    }));
  });

  it("rejects changed bytes and signed malformed fixtures before processing", async () => {
    const invalid = makeSignedHarness();
    const invalidResponse = await request(invalid.app)
      .post("/api/webhooks/resend")
      .set("content-type", "application/json")
      .set(signedHeaders(SIGNED_RAW_BODY))
      .send(`${SIGNED_RAW_BODY} `);

    expect(invalidResponse.status).toBe(401);
    expect(invalidResponse.body.code).toBe("invalid_provider_signature");
    expect(invalid.processor.process).not.toHaveBeenCalled();

    const malformedBody = JSON.stringify({
      type: "email.failed",
      created_at: "2025-01-15T10:20:29.125Z",
      data: {},
    });
    const malformed = makeSignedHarness();
    const malformedResponse = await request(malformed.app)
      .post("/api/webhooks/resend")
      .set("content-type", "application/json")
      .set(signedHeaders(malformedBody, "event-malformed"))
      .send(malformedBody);

    expect(malformedResponse.status).toBe(400);
    expect(malformedResponse.body.code).toBe("malformed_provider_event");
    expect(malformed.processor.process).not.toHaveBeenCalled();
  });

  it("returns 200 for a duplicate without another route-level transition", async () => {
    const { app, processor } = makeHarness();
    processor.process.mockResolvedValueOnce({
      disposition: "duplicate",
      outcome: "ignored",
    });

    const response = await webhook(app);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: true, duplicate: true });
  });

  it.each([
    ["invalid_provider_signature", 401],
    ["malformed_provider_event", 400],
  ] as const)("maps %s to %s", async (code, status) => {
    const { app, provider, processor } = makeHarness();
    provider.verifyWebhook.mockImplementationOnce(() => {
      throw new ReportDomainError(code);
    });

    const response = await webhook(app);
    expect(response.status).toBe(status);
    expect(response.body).toMatchObject({ code, correlationId: CORRELATION_ID });
    expect(processor.process).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when durable processing fails", async () => {
    const { app, processor } = makeHarness();
    processor.process.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await webhook(app);
    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      code: "provider_event_persistence_failed",
      message: "Provider webhook processing is temporarily unavailable.",
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(response.body)).not.toContain("database unavailable");
  });

  it("rejects requests that were not captured as JSON bytes", async () => {
    const { app, provider } = makeHarness();
    const response = await request(app)
      .post("/api/webhooks/resend")
      .set("content-type", "text/plain")
      .send(RAW_BODY);

    expect(response.status).toBe(400);
    expect(response.body.code).toBe("malformed_provider_event");
    expect(provider.verifyWebhook).not.toHaveBeenCalled();
  });
});
