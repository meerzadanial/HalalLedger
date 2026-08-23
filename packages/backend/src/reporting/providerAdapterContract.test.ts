import { createHash, createHmac, randomUUID } from "node:crypto";
import { Resend } from "resend";
import { describe, expect, it } from "vitest";
import type { Clock } from "./infrastructure";
import type {
  EmailProvider,
  EmailProviderCommand,
  ProviderWebhookHeaders,
} from "./provider";
import {
  ResendEmailProvider,
  type ResendClient,
} from "./resendEmailProvider";

const NOW = new Date("2025-01-15T10:20:30.000Z");
const SIGNING_KEY = Buffer.from("01234567890123456789012345678901", "utf8");
const LOCAL_WEBHOOK_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;
const LOCAL_MESSAGE_ID = "local-message-1";
const SAFE_LOCAL_RECIPIENT = "provider-contract@example.invalid";
const SAFE_RESEND_SANDBOX_RECIPIENT = "delivered@resend.dev";
const MEDIA_TYPE = "text/csv; charset=UTF-8" as const;

const clock: Clock = { now: () => new Date(NOW) };

type ResendPayload = Parameters<ResendClient["emails"]["send"]>[0];
type ResendOptions = Parameters<ResendClient["emails"]["send"]>[1];

interface RecordedSubmission {
  readonly payload: ResendPayload;
  readonly options: ResendOptions;
}

interface ProviderContractHarness {
  readonly provider: EmailProvider;
  readonly command: EmailProviderCommand;
  readonly providerMessageId: string;
  readonly webhookSecret: string;
  readonly submissions: readonly RecordedSubmission[];
}

type HarnessFactory = () => ProviderContractHarness | Promise<ProviderContractHarness>;
function commandFor(recipient: string, idempotencyKey: string): EmailProviderCommand {
  return {
    idempotencyKey,
    to: [recipient],
    subject: "Weekly Report: 2025-01-06 to 2025-01-12",
    textBody: "Report Type: weekly\nPeriod Start: 2025-01-06\nPeriod End: 2025-01-12",
    attachment: {
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: MEDIA_TYPE,
      bytes: new Uint8Array(Buffer.from("name,amount\r\nCafé,1.00\r\n", "utf8")),
    },
  };
}

function cloneSubmission(
  payload: ResendPayload,
  options: ResendOptions,
): RecordedSubmission {
  return {
    payload: {
      ...payload,
      to: [...payload.to] as [string],
      attachments: payload.attachments.map((attachment) => ({
        ...attachment,
        content: Buffer.from(attachment.content),
      })) as ResendPayload["attachments"],
    },
    options: { ...options },
  };
}

class DeterministicResendClient implements ResendClient {
  readonly submissions: RecordedSubmission[] = [];
  private readonly messagesByKey = new Map<string, string>();

  readonly emails = {
    send: async (payload: ResendPayload, options: ResendOptions) => {
      this.submissions.push(cloneSubmission(payload, options));
      const providerMessageId = this.messagesByKey.get(options.idempotencyKey)
        ?? LOCAL_MESSAGE_ID;
      this.messagesByKey.set(options.idempotencyKey, providerMessageId);
      return { data: { id: providerMessageId }, error: null };
    },
  };
}

class RecordingResendClient implements ResendClient {
  readonly submissions: RecordedSubmission[] = [];

  constructor(private readonly delegate: ResendClient) {}

  readonly emails = {
    send: async (payload: ResendPayload, options: ResendOptions) => {
      this.submissions.push(cloneSubmission(payload, options));
      return this.delegate.emails.send(payload, options);
    },
  };
}
function signWebhook(
  webhookSecret: string,
  rawBody: Buffer,
  providerEventId: string,
): ProviderWebhookHeaders {
  const timestamp = String(Math.floor(NOW.getTime() / 1_000));
  const key = Buffer.from(webhookSecret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key)
    .update(Buffer.concat([
      Buffer.from(`${providerEventId}.${timestamp}.`, "utf8"),
      rawBody,
    ]))
    .digest("base64");
  return {
    "svix-id": providerEventId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  };
}

function webhookBody(providerType: string, providerMessageId: string): Buffer {
  return Buffer.from(
    ` {\n  "type": "${providerType}",\n  "created_at": "2025-01-15T10:20:29.125Z",\n  "data": { "email_id": "${providerMessageId}", "label": "café" }\n}`,
    "utf8",
  );
}

/**
 * Reusable behavioral contract for an EmailProvider adapter. Harnesses expose
 * the provider transport boundary so the suite verifies bytes and cardinality,
 * not merely the command passed into the adapter.
 */
export function defineProviderAdapterContract(
  name: string,
  createHarness: HarnessFactory,
  enabled = true,
): void {
  const contractDescribe = enabled ? describe : describe.skip;

  contractDescribe(name, () => {
    it("transfers one recipient and one attachment and captures one stable acceptance", async () => {
      const harness = await createHarness();
      const first = await harness.provider.submit(harness.command);
      const second = await harness.provider.submit({
        ...harness.command,
        to: [harness.command.to[0]],
        attachment: {
          ...harness.command.attachment,
          bytes: new Uint8Array(harness.command.attachment.bytes),
        },
      });

      expect(first).toEqual({
        providerMessageId: harness.providerMessageId,
        acceptedAt: NOW,
      });
      expect(second).toEqual(first);
      expect(harness.submissions).toHaveLength(2);
      expect(new Set(harness.submissions.map(
        ({ options }) => options.idempotencyKey,
      ))).toEqual(new Set([harness.command.idempotencyKey]));
      for (const { payload, options } of harness.submissions) {
        expect(options).toEqual({
          idempotencyKey: harness.command.idempotencyKey,
        });
        expect(payload.to).toEqual([harness.command.to[0]]);
        expect(payload.attachments).toHaveLength(1);
        expect(payload.attachments[0]).toMatchObject({
          filename: harness.command.attachment.filename,
          contentType: harness.command.attachment.mediaType,
        });
        expect(Buffer.from(payload.attachments[0].content)).toEqual(
          Buffer.from(harness.command.attachment.bytes),
        );
      }
    });

    it.each([
      ["email.delivered", "delivered"],
      ["email.failed", "failed"],
      ["email.bounced", "bounced"],
      ["email.suppressed", "suppressed"],
    ] as const)("validates and maps %s to %s", async (providerType, eventType) => {
      const harness = await createHarness();
      const providerEventId = `contract-${eventType}`;
      const rawBody = webhookBody(providerType, harness.providerMessageId);
      const event = harness.provider.verifyWebhook(
        rawBody,
        signWebhook(harness.webhookSecret, rawBody, providerEventId),
      );

      expect(event).toEqual({
        providerEventId,
        providerMessageId: harness.providerMessageId,
        eventType,
        occurredAt: new Date("2025-01-15T10:20:29.125Z"),
        payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
      });
    });

    it("validates the unmodified raw bytes rather than reserialized JSON", async () => {
      const harness = await createHarness();
      const rawBody = webhookBody("email.delivered", harness.providerMessageId);
      const headers = signWebhook(
        harness.webhookSecret,
        rawBody,
        "contract-raw-signature",
      );

      expect(harness.provider.verifyWebhook(rawBody, headers).eventType)
        .toBe("delivered");
      expect(() => harness.provider.verifyWebhook(
        Buffer.concat([rawBody, Buffer.from(" ")]),
        headers,
      )).toThrow(expect.objectContaining({ code: "invalid_provider_signature" }));
    });
  });
}
function localHarness(): ProviderContractHarness {
  const client = new DeterministicResendClient();
  const command = commandFor(
    SAFE_LOCAL_RECIPIENT,
    "report:11111111-1111-4111-8111-111111111111",
  );
  return {
    provider: new ResendEmailProvider(
      {
        apiKey: "re_local_contract_key",
        webhookSecret: LOCAL_WEBHOOK_SECRET,
        fromEmail: "Reports <reports@example.invalid>",
      },
      { client, clock },
    ),
    command,
    providerMessageId: LOCAL_MESSAGE_ID,
    webhookSecret: LOCAL_WEBHOOK_SECRET,
    submissions: client.submissions,
  };
}

function requireSandboxEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required for the explicitly gated staging contract.`);
  }
  return value;
}

function sandboxHarness(): ProviderContractHarness {
  if (process.env.RESEND_SANDBOX_STAGE !== "staging") {
    throw new Error(
      "RESEND_SANDBOX_STAGE must equal staging before sandbox network access is allowed.",
    );
  }

  const apiKey = requireSandboxEnvironment("RESEND_API_KEY");
  const webhookSecret = requireSandboxEnvironment("RESEND_WEBHOOK_SECRET");
  const fromEmail = requireSandboxEnvironment("REPORT_FROM_EMAIL");
  const resend = new Resend(apiKey);
  const client = new RecordingResendClient({
    emails: {
      send: (payload, options) => resend.emails.send(payload, options),
    },
  });
  let acceptedProviderMessageId = "sandbox-contract-message";
  const command = commandFor(
    SAFE_RESEND_SANDBOX_RECIPIENT,
    `report:${randomUUID()}`,
  );

  const provider = new ResendEmailProvider(
    { apiKey, webhookSecret, fromEmail },
    { client, clock },
  );

  return {
    provider: {
      verifyWebhook: provider.verifyWebhook.bind(provider),
      submit: async (submission) => {
        const acceptance = await provider.submit(submission);
        acceptedProviderMessageId = acceptance.providerMessageId;
        return acceptance;
      },
    },
    command,
    get providerMessageId() {
      return acceptedProviderMessageId;
    },
    webhookSecret,
    submissions: client.submissions,
  };
}
defineProviderAdapterContract(
  "EmailProvider contract: deterministic local Resend transport",
  localHarness,
);

defineProviderAdapterContract(
  "EmailProvider contract: explicitly gated Resend staging sandbox",
  sandboxHarness,
  process.env.RUN_RESEND_SANDBOX_CONTRACT === "true",
);
