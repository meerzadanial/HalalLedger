import { describe, expect, it, vi } from "vitest";
import {
  DefaultReportTelemetry,
  InMemoryReportMetrics,
  JsonReportLogger,
  REPORT_EVENTS,
  hashReportEmail,
} from "./observability";

describe("report observability", () => {
  it("writes one-line JSON with only allowlisted operational fields", () => {
    const sink = vi.fn();
    const logger = new JsonReportLogger(sink);

    logger.log(REPORT_EVENTS.csvGenerated, {
      reportRequestId: "report-1",
      stage: "csv_generation",
      durationMs: 12,
      recordCount: 3,
      csvByteSize: 128,
      emailHash: hashReportEmail("Driver@Example.com"),
      accountEmail: "driver@example.com",
      recipientEmail: "recipient@example.com",
      csvContent: "restaurant,secret",
      restaurantName: "Sensitive Restaurant",
      token: "bearer-secret",
      apiKey: "provider-key",
      signature: "webhook-signature",
      stack: "secret stack trace",
      rawProviderPayload: { secret: true },
    } as never);

    expect(sink).toHaveBeenCalledOnce();
    const line = sink.mock.calls[0][0] as string;
    expect(line).not.toContain("driver@example.com");
    expect(line).not.toContain("recipient@example.com");
    expect(line).not.toContain("restaurant,secret");
    expect(line).not.toContain("Sensitive Restaurant");
    expect(line).not.toContain("bearer-secret");
    expect(line).not.toContain("provider-key");
    expect(line).not.toContain("webhook-signature");
    expect(line).not.toContain("stack trace");
    const structured = JSON.parse(line) as Record<string, unknown>;
    expect(structured).toMatchObject({
      event: "csv_generated",
      reportRequestId: "report-1",
      stage: "csv_generation",
      durationMs: 12,
      recordCount: 3,
      csvByteSize: 128,
      emailHash: hashReportEmail("driver@example.com"),
    });
    expect(Object.keys(structured).sort()).toEqual([
      "csvByteSize",
      "durationMs",
      "emailHash",
      "event",
      "recordCount",
      "reportRequestId",
      "stage",
    ]);
  });

  it("normalizes and one-way hashes email without retaining the address", () => {
    const first = hashReportEmail(" Driver@Example.com ");
    expect(first).toBe(hashReportEmail("driver@example.com"));
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain("driver");
    expect(first).not.toContain("example.com");
  });

  it("derives bounded-label counters and latency/value histograms", () => {
    const metrics = new InMemoryReportMetrics();
    const telemetry = new DefaultReportTelemetry(
      new JsonReportLogger(() => undefined),
      metrics,
    );

    telemetry.emit(REPORT_EVENTS.apiRequest, {
      requestId: "request-1",
      operation: "create_request",
      httpStatus: 202,
      durationMs: 8,
    });
    telemetry.emit(REPORT_EVENTS.requestBlocked, {
      reportRequestId: "report-1",
      operation: "create",
      errorCode: "report_in_progress",
    });
    telemetry.emit(REPORT_EVENTS.jobClaimed, {
      reportRequestId: "report-1",
      stage: "coordination",
      attempt: 1,
    });
    telemetry.emit(REPORT_EVENTS.snapshotCommitted, {
      reportRequestId: "report-1",
      stage: "snapshot",
      durationMs: 15,
      recordCount: 4,
    });
    telemetry.emit(REPORT_EVENTS.csvGenerated, {
      reportRequestId: "report-1",
      stage: "csv_generation",
      csvByteSize: 512,
    });
    telemetry.emit(REPORT_EVENTS.webhookApplied, {
      reportRequestId: "report-1",
      eventType: "delivered",
      statusTo: "sent",
      confirmationLatencyMs: 2_000,
    });
    telemetry.emit(REPORT_EVENTS.providerSubmissionAttempted, {
      reportRequestId: "report-1",
      stage: "email_submission",
    });
    telemetry.emit(REPORT_EVENTS.deadlineFailure, {
      reportRequestId: "report-2",
      stage: "email_submission",
      errorCode: "delivery_timeout",
    });
    telemetry.emit(REPORT_EVENTS.retryCreated, {
      reportRequestId: "report-3",
      operation: "retry",
    });
    telemetry.emit(REPORT_EVENTS.terminalTransition, {
      reportRequestId: "report-1",
      statusTo: "sent",
    });

    const snapshot = metrics.snapshot();
    expect(snapshot.counters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "report_api_requests_total", value: 1 }),
      expect.objectContaining({ name: "report_conflicts_total", value: 1 }),
      expect.objectContaining({ name: "report_worker_jobs_total", value: 1 }),
      expect.objectContaining({ name: "report_snapshots_total", value: 1 }),
      expect.objectContaining({ name: "report_csv_generated_total", value: 1 }),
      expect.objectContaining({ name: "report_webhooks_total", value: 1 }),
      expect.objectContaining({ name: "report_provider_attempts_total", value: 1 }),
      expect.objectContaining({ name: "report_deadline_failures_total", value: 1 }),
      expect.objectContaining({ name: "report_retries_total", value: 1 }),
      expect.objectContaining({ name: "report_terminal_total", value: 1 }),
    ]));
    expect(snapshot.histograms).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "report_api_duration_ms", values: [8] }),
      expect.objectContaining({ name: "report_snapshot_records", values: [4] }),
      expect.objectContaining({ name: "report_csv_bytes", values: [512] }),
      expect.objectContaining({ name: "report_confirmation_latency_ms", values: [2_000] }),
    ]));
  });
});
