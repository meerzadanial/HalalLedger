import { describe, expect, it } from "vitest";
import {
  loadReportOperationalConfig,
  requireWorkerReportConfig,
} from "./operationalConfig";

const validEnvironment = {
  RESEND_API_KEY: "re_test_key",
  RESEND_WEBHOOK_SECRET: "whsec_dGVzdC1rZXk=",
  REPORT_FROM_EMAIL: "reports@example.com",
  REPORT_PUBLIC_WEBHOOK_URL: "https://reports.example.com/api/webhooks/resend",
  REPORT_WORKER_ID: "worker-a",
} as const;

describe("report operational configuration", () => {
  it("applies bounded operational defaults and the exact attachment limit", () => {
    const config = loadReportOperationalConfig(validEnvironment);

    expect(config).toMatchObject({
      attachmentLimitBytes: 10_485_760,
      leaseDurationMs: 60_000,
      initialBackoffMs: 1_000,
      maxBackoffMs: 300_000,
      maxAttempts: 8,
      workerPollIntervalMs: 1_000,
      retentionDays: 7,
      provider: { configured: true },
      alerts: {
        staleLeaseCount: 1,
        failureSpikeCount: 5,
        invalidSignatureSpikeCount: 5,
        approachingDeadlineCount: 1,
        approachingDeadlineSeconds: 60,
      },
    });
    expect(() => requireWorkerReportConfig(config)).not.toThrow();
  });

  it("loads explicit valid worker, retention, and alert settings", () => {
    const config = loadReportOperationalConfig({
      ...validEnvironment,
      REPORT_ATTACHMENT_LIMIT_BYTES: "10485760",
      REPORT_JOB_LEASE_MS: "90000",
      REPORT_JOB_INITIAL_BACKOFF_MS: "2500",
      REPORT_JOB_MAX_BACKOFF_MS: "120000",
      REPORT_JOB_MAX_ATTEMPTS: "6",
      REPORT_WORKER_POLL_INTERVAL_MS: "1500",
      REPORT_WORKER_HEARTBEAT_MAX_AGE_MS: "180000",
      REPORT_ATTACHMENT_RETENTION_DAYS: "30",
      REPORT_RETENTION_SWEEP_INTERVAL_MS: "7200000",
      REPORT_ALERT_STALE_LEASE_COUNT: "2",
      REPORT_ALERT_FAILURE_SPIKE_COUNT: "9",
      REPORT_ALERT_INVALID_SIGNATURE_SPIKE_COUNT: "4",
      REPORT_ALERT_APPROACHING_DEADLINE_COUNT: "3",
      REPORT_ALERT_APPROACHING_DEADLINE_SECONDS: "45",
    });

    expect(config).toMatchObject({
      leaseDurationMs: 90_000,
      initialBackoffMs: 2_500,
      maxBackoffMs: 120_000,
      maxAttempts: 6,
      workerPollIntervalMs: 1_500,
      workerHeartbeatMaxAgeMs: 180_000,
      retentionDays: 30,
      retentionSweepIntervalMs: 7_200_000,
      alerts: {
        staleLeaseCount: 2,
        failureSpikeCount: 9,
        invalidSignatureSpikeCount: 4,
        approachingDeadlineCount: 3,
        approachingDeadlineSeconds: 45,
      },
    });
    expect(() => requireWorkerReportConfig(config)).not.toThrow();
  });

  it("allows API startup without provider values but rejects worker startup", () => {
    const config = loadReportOperationalConfig({});

    expect(config.provider).toEqual({
      apiKey: null,
      webhookSecret: null,
      fromEmail: null,
      publicWebhookUrl: null,
      configured: false,
    });
    expect(config.workerId).toBeNull();
    expect(() => requireWorkerReportConfig(config)).toThrow(
      "RESEND_API_KEY, RESEND_WEBHOOK_SECRET, REPORT_FROM_EMAIL, REPORT_PUBLIC_WEBHOOK_URL, REPORT_WORKER_ID",
    );
  });

  it("rejects invalid limits, backoff ordering, provider fields, and webhook URLs", () => {
    expect(() => loadReportOperationalConfig({
      ...validEnvironment,
      REPORT_ATTACHMENT_LIMIT_BYTES: "10485759",
    })).toThrow("REPORT_ATTACHMENT_LIMIT_BYTES must be 10485760");
    expect(() => loadReportOperationalConfig({
      ...validEnvironment,
      REPORT_JOB_INITIAL_BACKOFF_MS: "2000",
      REPORT_JOB_MAX_BACKOFF_MS: "1000",
    })).toThrow("cannot exceed");
    expect(() => loadReportOperationalConfig({
      ...validEnvironment,
      REPORT_FROM_EMAIL: "not-an-email",
    })).toThrow("valid email address");
    expect(() => loadReportOperationalConfig({
      ...validEnvironment,
      REPORT_PUBLIC_WEBHOOK_URL: "http://example.com/api/webhooks/resend",
    })).toThrow("valid HTTPS URL");
  });
});
