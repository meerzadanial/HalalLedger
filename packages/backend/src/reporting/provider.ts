import type { REPORT_CSV_MEDIA_TYPE } from "./constants";
import type { VerifiedProviderEvent } from "./models";

export interface EmailAttachmentCommand {
  readonly filename: string;
  readonly mediaType: typeof REPORT_CSV_MEDIA_TYPE;
  readonly bytes: Uint8Array;
}

export interface EmailProviderCommand {
  readonly idempotencyKey: string;
  readonly to: readonly [string];
  readonly subject: string;
  readonly textBody: string;
  readonly attachment: EmailAttachmentCommand;
}

export interface EmailProviderAcceptance {
  readonly providerMessageId: string;
  readonly acceptedAt: Date;
}

export const EMAIL_PROVIDER_SUBMISSION_FAILURE_KINDS = Object.freeze([
  "rejected",
  "unavailable",
  "invalid_response",
] as const);
export type EmailProviderSubmissionFailureKind =
  (typeof EMAIL_PROVIDER_SUBMISSION_FAILURE_KINDS)[number];

/**
 * Adapter-safe provider failure. The fixed message prevents provider payloads,
 * credentials, or response details from escaping through service boundaries.
 */
export class EmailProviderSubmissionError extends Error {
  readonly kind: EmailProviderSubmissionFailureKind;
  readonly definitive: boolean;

  constructor(
    kind: EmailProviderSubmissionFailureKind,
    options: { readonly cause?: unknown } = {},
  ) {
    super("Email provider submission failed.", { cause: options.cause });
    this.name = "EmailProviderSubmissionError";
    this.kind = kind;
    this.definitive = kind === "rejected";
  }
}

export function isEmailProviderSubmissionError(
  error: unknown,
): error is EmailProviderSubmissionError {
  return error instanceof EmailProviderSubmissionError;
}

export type ProviderWebhookHeaders = Readonly<
  Record<string, string | readonly string[]>
>;

export interface EmailProvider {
  submit(command: EmailProviderCommand): Promise<EmailProviderAcceptance>;
  verifyWebhook(
    rawBody: Buffer,
    headers: ProviderWebhookHeaders,
  ): VerifiedProviderEvent;
}
