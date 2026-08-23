import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import { Resend } from "resend";
import type { ProviderEventType } from "./constants";
import { ReportDomainError } from "./errors";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";
import type { VerifiedProviderEvent } from "./models";
import {
  EmailProviderSubmissionError,
  type EmailProvider,
  type EmailProviderAcceptance,
  type EmailProviderCommand,
  type ProviderWebhookHeaders,
} from "./provider";

const WEBHOOK_TOLERANCE_SECONDS = 300;
const WEBHOOK_SECRET_PREFIX = "whsec_";

const EVENT_TYPES = Object.freeze({
  "email.delivered": "delivered",
  "email.failed": "failed",
  "email.bounced": "bounced",
  "email.suppressed": "suppressed",
} as const satisfies Record<string, ProviderEventType>);

const DEFINITIVE_RESEND_ERRORS = new Set([
  "missing_required_field",
  "invalid_idempotency_key",
  "invalid_idempotent_request",
  "invalid_access",
  "invalid_parameter",
  "invalid_region",
  "missing_api_key",
  "invalid_api_Key",
  "invalid_from_address",
  "validation_error",
  "not_found",
  "method_not_allowed",
]);

const RETRYABLE_RESEND_ERRORS = new Set([
  "concurrent_idempotent_requests",
  "rate_limit_exceeded",
  "application_error",
  "internal_server_error",
]);

interface ResendEmailPayload {
  readonly from: string;
  readonly to: [string];
  readonly subject: string;
  readonly text: string;
  readonly attachments: [{
    readonly filename: string;
    readonly contentType: string;
    readonly content: Buffer;
  }];
}

interface ResendSendResponse {
  readonly data: { readonly id: string } | null;
  readonly error: { readonly name: string; readonly message: string } | null;
}

export interface ResendClient {
  readonly emails: {
    send(
      payload: ResendEmailPayload,
      options: { readonly idempotencyKey: string },
    ): Promise<ResendSendResponse>;
  };
}

export interface ResendEmailProviderConfig {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly fromEmail: string;
}

export interface ResendEmailProviderOptions {
  readonly clock?: Clock;
  readonly client?: ResendClient;
}

export class ResendEmailProvider implements EmailProvider {
  private readonly clock: Clock;
  private readonly client: ResendClient;
  private readonly webhookKey: Buffer;

  constructor(
    private readonly config: ResendEmailProviderConfig,
    options: ResendEmailProviderOptions = {},
  ) {
    requireConfigured("apiKey", config.apiKey);
    requireConfigured("fromEmail", config.fromEmail);
    requireConfigured("webhookSecret", config.webhookSecret);
    this.webhookKey = decodeWebhookSecret(config.webhookSecret);
    this.clock = options.clock ?? new SystemClock();
    this.client = options.client ?? new Resend(config.apiKey);
  }

  async submit(
    command: EmailProviderCommand,
  ): Promise<EmailProviderAcceptance> {
    if (
      command.to.length !== 1 ||
      command.to[0].length === 0 ||
      command.idempotencyKey.length === 0 ||
      command.idempotencyKey.length > 256
    ) {
      throw new EmailProviderSubmissionError("rejected");
    }

    let response: ResendSendResponse;
    try {
      response = await this.client.emails.send(
        {
          from: this.config.fromEmail,
          to: [command.to[0]],
          subject: command.subject,
          text: command.textBody,
          attachments: [{
            filename: command.attachment.filename,
            contentType: command.attachment.mediaType,
            content: Buffer.from(command.attachment.bytes),
          }],
        },
        { idempotencyKey: command.idempotencyKey },
      );
    } catch {
      throw new EmailProviderSubmissionError("unavailable");
    }

    return this.toAcceptance(response);
  }

  verifyWebhook(
    rawBody: Buffer,
    headers: ProviderWebhookHeaders,
  ): VerifiedProviderEvent {
    const providerEventId = readHeader(headers, "svix-id");
    const timestamp = readHeader(headers, "svix-timestamp");
    const signatures = readHeader(headers, "svix-signature", true);

    if (
      providerEventId === undefined ||
      timestamp === undefined ||
      signatures === undefined ||
      !this.hasValidSignature(rawBody, providerEventId, timestamp, signatures)
    ) {
      throw new ReportDomainError("invalid_provider_signature");
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new ReportDomainError("malformed_provider_event");
    }

    return mapEvent(payload, providerEventId, rawBody);
  }

  private toAcceptance(response: ResendSendResponse): EmailProviderAcceptance {
    if (response?.error !== null) {
      const name = response?.error?.name;
      if (typeof name === "string" && DEFINITIVE_RESEND_ERRORS.has(name)) {
        throw new EmailProviderSubmissionError("rejected");
      }
      if (typeof name === "string" && RETRYABLE_RESEND_ERRORS.has(name)) {
        throw new EmailProviderSubmissionError("unavailable");
      }
      throw new EmailProviderSubmissionError("invalid_response");
    }

    const providerMessageId = response?.data?.id;
    if (typeof providerMessageId !== "string" || providerMessageId.length === 0) {
      throw new EmailProviderSubmissionError("invalid_response");
    }

    const acceptedAt = this.clock.now();
    if (!Number.isFinite(acceptedAt.getTime())) {
      throw new EmailProviderSubmissionError("invalid_response");
    }

    return {
      providerMessageId,
      acceptedAt: new Date(acceptedAt),
    };
  }

  private hasValidSignature(
    rawBody: Buffer,
    providerEventId: string,
    timestamp: string,
    signatureHeader: string,
  ): boolean {
    if (!/^\d+$/.test(timestamp)) {
      return false;
    }

    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(this.clock.now().getTime() / 1_000);
    if (
      !Number.isSafeInteger(timestampSeconds) ||
      !Number.isFinite(nowSeconds) ||
      Math.abs(nowSeconds - timestampSeconds) > WEBHOOK_TOLERANCE_SECONDS
    ) {
      return false;
    }

    const signedPayload = Buffer.concat([
      Buffer.from(`${providerEventId}.${timestamp}.`, "utf8"),
      rawBody,
    ]);
    const expected = createHmac("sha256", this.webhookKey)
      .update(signedPayload)
      .digest();

    return signatureHeader.split(/\s+/u).some((entry) => {
      const [version, encoded, extra] = entry.split(",");
      if (version !== "v1" || encoded === undefined || extra !== undefined) {
        return false;
      }
      const actual = decodeBase64(encoded);
      return actual.length === expected.length && timingSafeEqual(actual, expected);
    });
  }
}

function mapEvent(
  payload: unknown,
  providerEventId: string,
  rawBody: Buffer,
): VerifiedProviderEvent {
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new ReportDomainError("malformed_provider_event");
  }

  const eventType = EVENT_TYPES[payload.type as keyof typeof EVENT_TYPES];
  const providerMessageId = payload.data.email_id;
  const occurredAt = parseProviderDate(payload.created_at);
  if (
    eventType === undefined ||
    typeof providerMessageId !== "string" ||
    providerMessageId.length === 0 ||
    occurredAt === null
  ) {
    throw new ReportDomainError("malformed_provider_event");
  }

  return {
    providerEventId,
    providerMessageId,
    eventType,
    occurredAt,
    payloadDigest: createHash("sha256").update(rawBody).digest("hex"),
  };
}

function readHeader(
  headers: ProviderWebhookHeaders,
  expectedName: string,
  allowMultiple = false,
): string | undefined {
  const match = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === expectedName,
  );
  if (match === undefined) {
    return undefined;
  }

  const value = match[1];
  if (typeof value === "string") {
    return value.length === 0 ? undefined : value;
  }
  if (value.length === 0 || (!allowMultiple && value.length !== 1)) {
    return undefined;
  }

  const combined = value.join(" ");
  return combined.length === 0 ? undefined : combined;
}

function decodeWebhookSecret(secret: string): Buffer {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) {
    throw new TypeError("Resend webhook secret is not configured correctly.");
  }
  const key = decodeBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length));
  if (key.length === 0) {
    throw new TypeError("Resend webhook secret is not configured correctly.");
  }
  return key;
}

function decodeBase64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    return Buffer.alloc(0);
  }
  return Buffer.from(value, "base64");
}

function parseProviderDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireConfigured(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`Resend ${name} is required.`);
  }
}

export { WEBHOOK_TOLERANCE_SECONDS };