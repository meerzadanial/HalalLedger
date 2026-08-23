import { REPORT_ATTACHMENT_LIMIT_BYTES } from "./constants";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface ReportAlertThresholds {
  readonly staleLeaseCount: number;
  readonly failureSpikeCount: number;
  readonly invalidSignatureSpikeCount: number;
  readonly approachingDeadlineCount: number;
  readonly approachingDeadlineSeconds: number;
}

export interface ReportOperationalConfig {
  readonly provider: {
    readonly apiKey: string | null;
    readonly webhookSecret: string | null;
    readonly fromEmail: string | null;
    readonly publicWebhookUrl: string | null;
    readonly configured: boolean;
  };
  readonly attachmentLimitBytes: typeof REPORT_ATTACHMENT_LIMIT_BYTES;
  readonly leaseDurationMs: number;
  readonly initialBackoffMs: number;
  readonly maxBackoffMs: number;
  readonly maxAttempts: number;
  readonly workerId: string | null;
  readonly workerPollIntervalMs: number;
  readonly workerHeartbeatMaxAgeMs: number;
  readonly retentionDays: number;
  readonly retentionSweepIntervalMs: number;
  readonly alerts: ReportAlertThresholds;
}

export function loadReportOperationalConfig(
  env: Environment = process.env,
): ReportOperationalConfig {
  const apiKey = optional(env.RESEND_API_KEY);
  const webhookSecret = optional(env.RESEND_WEBHOOK_SECRET);
  const fromEmail = optional(env.REPORT_FROM_EMAIL);
  const publicWebhookUrl = optional(env.REPORT_PUBLIC_WEBHOOK_URL);
  validateOptionalEmail(fromEmail);
  validateOptionalWebhookUrl(publicWebhookUrl);
  validateOptionalWebhookSecret(webhookSecret);

  const attachmentLimitBytes = integer(
    env.REPORT_ATTACHMENT_LIMIT_BYTES,
    REPORT_ATTACHMENT_LIMIT_BYTES,
    "REPORT_ATTACHMENT_LIMIT_BYTES",
  );
  if (attachmentLimitBytes !== REPORT_ATTACHMENT_LIMIT_BYTES) {
    throw new TypeError(
      `REPORT_ATTACHMENT_LIMIT_BYTES must be ${REPORT_ATTACHMENT_LIMIT_BYTES}`,
    );
  }

  const leaseDurationMs = integer(env.REPORT_JOB_LEASE_MS, 60_000, "REPORT_JOB_LEASE_MS");
  const initialBackoffMs = integer(env.REPORT_JOB_INITIAL_BACKOFF_MS, 1_000, "REPORT_JOB_INITIAL_BACKOFF_MS");
  const maxBackoffMs = integer(env.REPORT_JOB_MAX_BACKOFF_MS, 300_000, "REPORT_JOB_MAX_BACKOFF_MS");
  if (initialBackoffMs > maxBackoffMs) {
    throw new TypeError("REPORT_JOB_INITIAL_BACKOFF_MS cannot exceed REPORT_JOB_MAX_BACKOFF_MS");
  }
  const workerPollIntervalMs = integer(
    env.REPORT_WORKER_POLL_INTERVAL_MS,
    1_000,
    "REPORT_WORKER_POLL_INTERVAL_MS",
  );
  const workerHeartbeatMaxAgeMs = integer(
    env.REPORT_WORKER_HEARTBEAT_MAX_AGE_MS,
    120_000,
    "REPORT_WORKER_HEARTBEAT_MAX_AGE_MS",
  );
  if (workerPollIntervalMs >= leaseDurationMs) {
    throw new TypeError("REPORT_WORKER_POLL_INTERVAL_MS must be less than REPORT_JOB_LEASE_MS");
  }
  if (workerHeartbeatMaxAgeMs <= workerPollIntervalMs) {
    throw new TypeError("REPORT_WORKER_HEARTBEAT_MAX_AGE_MS must exceed REPORT_WORKER_POLL_INTERVAL_MS");
  }

  return {
    provider: {
      apiKey,
      webhookSecret,
      fromEmail,
      publicWebhookUrl,
      configured: [apiKey, webhookSecret, fromEmail, publicWebhookUrl].every(
        (value) => value !== null,
      ),
    },
    attachmentLimitBytes: REPORT_ATTACHMENT_LIMIT_BYTES,
    leaseDurationMs,
    initialBackoffMs,
    maxBackoffMs,
    maxAttempts: integer(env.REPORT_JOB_MAX_ATTEMPTS, 8, "REPORT_JOB_MAX_ATTEMPTS"),
    workerId: optional(env.REPORT_WORKER_ID),
    workerPollIntervalMs,
    workerHeartbeatMaxAgeMs,
    retentionDays: integer(env.REPORT_ATTACHMENT_RETENTION_DAYS, 7, "REPORT_ATTACHMENT_RETENTION_DAYS"),
    retentionSweepIntervalMs: integer(env.REPORT_RETENTION_SWEEP_INTERVAL_MS, 3_600_000, "REPORT_RETENTION_SWEEP_INTERVAL_MS"),
    alerts: {
      staleLeaseCount: integer(env.REPORT_ALERT_STALE_LEASE_COUNT, 1, "REPORT_ALERT_STALE_LEASE_COUNT"),
      failureSpikeCount: integer(env.REPORT_ALERT_FAILURE_SPIKE_COUNT, 5, "REPORT_ALERT_FAILURE_SPIKE_COUNT"),
      invalidSignatureSpikeCount: integer(env.REPORT_ALERT_INVALID_SIGNATURE_SPIKE_COUNT, 5, "REPORT_ALERT_INVALID_SIGNATURE_SPIKE_COUNT"),
      approachingDeadlineCount: integer(env.REPORT_ALERT_APPROACHING_DEADLINE_COUNT, 1, "REPORT_ALERT_APPROACHING_DEADLINE_COUNT"),
      approachingDeadlineSeconds: integer(env.REPORT_ALERT_APPROACHING_DEADLINE_SECONDS, 60, "REPORT_ALERT_APPROACHING_DEADLINE_SECONDS"),
    },
  };
}

export function requireWorkerReportConfig(
  config: ReportOperationalConfig,
): asserts config is ReportOperationalConfig & {
  provider: ReportOperationalConfig["provider"] & {
    apiKey: string;
    webhookSecret: string;
    fromEmail: string;
    publicWebhookUrl: string;
    configured: true;
  };
  workerId: string;
} {
  const missing: string[] = [];
  if (config.provider.apiKey === null) missing.push("RESEND_API_KEY");
  if (config.provider.webhookSecret === null) missing.push("RESEND_WEBHOOK_SECRET");
  if (config.provider.fromEmail === null) missing.push("REPORT_FROM_EMAIL");
  if (config.provider.publicWebhookUrl === null) missing.push("REPORT_PUBLIC_WEBHOOK_URL");
  if (config.workerId === null) missing.push("REPORT_WORKER_ID");
  if (missing.length > 0) {
    throw new TypeError(`Report worker configuration is missing: ${missing.join(", ")}`);
  }
}

function optional(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized === "" ? null : normalized;
}

function integer(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function validateOptionalEmail(value: string | null): void {
  if (value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new TypeError("REPORT_FROM_EMAIL must be a valid email address");
  }
}

function validateOptionalWebhookSecret(value: string | null): void {
  if (value !== null && !/^whsec_[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new TypeError("RESEND_WEBHOOK_SECRET is not configured correctly");
  }
}

function validateOptionalWebhookUrl(value: string | null): void {
  if (value === null) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("REPORT_PUBLIC_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new TypeError("REPORT_PUBLIC_WEBHOOK_URL must be a valid HTTPS URL");
  }
  if (url.pathname !== "/api/webhooks/resend") {
    throw new TypeError("REPORT_PUBLIC_WEBHOOK_URL must end with /api/webhooks/resend");
  }
}
