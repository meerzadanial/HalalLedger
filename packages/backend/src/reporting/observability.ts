import { createHash } from "node:crypto";

export const REPORT_EVENTS = Object.freeze({
  apiRequest: "api_request",
  requestCreated: "request_created",
  requestDeduplicated: "request_deduplicated",
  requestBlocked: "request_blocked",
  retryCreated: "retry_created",
  jobClaimed: "job_claimed",
  jobRetried: "job_retried",
  snapshotCommitted: "snapshot_committed",
  csvGenerated: "csv_generated",
  providerSubmissionAttempted: "provider_submission_attempted",
  providerSubmissionAccepted: "provider_submission_accepted",
  providerSubmissionRejected: "provider_submission_rejected",
  webhookVerified: "webhook_verified",
  webhookInvalid: "webhook_invalid",
  webhookDeduplicated: "webhook_deduplicated",
  webhookApplied: "webhook_applied",
  webhookIgnored: "webhook_ignored",
  deadlineFailure: "deadline_failure",
  leaseSweep: "lease_sweep",
  retentionSweep: "retention_sweep",
  workerHeartbeat: "worker_heartbeat",
  workerCycleFailed: "worker_cycle_failed",
  terminalTransition: "terminal_transition",
} as const);

export type ReportEvent = (typeof REPORT_EVENTS)[keyof typeof REPORT_EVENTS];

export interface ReportOperationalFields {
  readonly requestId?: string;
  readonly reportRequestId?: string;
  readonly userId?: string;
  readonly statusFrom?: string;
  readonly statusTo?: string;
  readonly stage?: string;
  readonly attempt?: number;
  readonly durationMs?: number;
  readonly confirmationLatencyMs?: number;
  readonly recordCount?: number;
  readonly csvByteSize?: number;
  readonly providerMessageId?: string;
  readonly providerEventId?: string;
  readonly errorCode?: string;
  readonly emailHash?: string;
  readonly disposition?: string;
  readonly operation?: string;
  readonly httpMethod?: string;
  readonly httpStatus?: number;
  readonly eventType?: string;
  readonly timedOutCount?: number;
  readonly staleLeaseCount?: number;
  readonly approachingDeadlineCount?: number;
  readonly deletedAttachmentCount?: number;
}

export interface ReportLogger {
  log(event: ReportEvent, fields?: ReportOperationalFields): void;
}

export type ReportCounterName =
  | "report_api_requests_total"
  | "report_worker_jobs_total"
  | "report_snapshots_total"
  | "report_csv_generated_total"
  | "report_provider_attempts_total"
  | "report_webhooks_total"
  | "report_deadline_failures_total"
  | "report_retries_total"
  | "report_conflicts_total"
  | "report_terminal_total";

export type ReportHistogramName =
  | "report_api_duration_ms"
  | "report_stage_duration_ms"
  | "report_snapshot_records"
  | "report_csv_bytes"
  | "report_confirmation_latency_ms";

export type ReportMetricLabels = Readonly<Partial<Pick<
  ReportOperationalFields,
  "stage" | "statusTo" | "errorCode" | "disposition" | "operation" | "eventType"
>>>;

export type ReportGaugeName =
  | "report_stale_leases"
  | "report_approaching_deadlines";

export interface ReportMetrics {
  increment(name: ReportCounterName, labels?: ReportMetricLabels): void;
  observe(
    name: ReportHistogramName,
    value: number,
    labels?: ReportMetricLabels,
  ): void;
  setGauge(name: ReportGaugeName, value: number): void;
}

export interface ReportMetricSnapshot {
  readonly counters: readonly {
    readonly name: ReportCounterName;
    readonly labels: ReportMetricLabels;
    readonly value: number;
  }[];
  readonly histograms: readonly {
    readonly name: ReportHistogramName;
    readonly labels: ReportMetricLabels;
    readonly values: readonly number[];
  }[];
  readonly gauges: readonly {
    readonly name: ReportGaugeName;
    readonly value: number;
  }[];
}

export interface ReportTelemetry {
  emit(event: ReportEvent, fields?: ReportOperationalFields): void;
}

const OPERATIONAL_FIELD_NAMES = [
  "requestId", "reportRequestId", "userId", "statusFrom", "statusTo",
  "stage", "attempt", "durationMs", "confirmationLatencyMs", "recordCount", "csvByteSize",
  "providerMessageId", "providerEventId", "errorCode", "emailHash",
  "disposition", "operation", "httpMethod", "httpStatus", "eventType",
  "timedOutCount", "staleLeaseCount", "approachingDeadlineCount",
  "deletedAttachmentCount",
] as const satisfies readonly (keyof ReportOperationalFields)[];

const METRIC_LABEL_NAMES = [
  "stage", "statusTo", "errorCode", "disposition", "operation", "eventType",
] as const satisfies readonly (keyof ReportMetricLabels)[];

type JsonSink = (line: string) => void;

/** Writes one-line JSON containing only explicitly allowlisted operational data. */
export class JsonReportLogger implements ReportLogger {
  constructor(private readonly sink: JsonSink = (line) => console.log(line)) {}

  log(event: ReportEvent, fields: ReportOperationalFields = {}): void {
    const safe: Record<string, string | number> = { event };
    for (const name of OPERATIONAL_FIELD_NAMES) {
      const value = fields[name];
      if (typeof value === "string") safe[name] = value;
      if (typeof value === "number" && Number.isFinite(value)) safe[name] = value;
    }
    this.sink(JSON.stringify(safe));
  }
}

/** In-process metric store suitable for process exporters and readiness probes. */
export class InMemoryReportMetrics implements ReportMetrics {
  private readonly counters = new Map<string, { name: ReportCounterName; labels: ReportMetricLabels; value: number }>();
  private readonly histograms = new Map<string, { name: ReportHistogramName; labels: ReportMetricLabels; values: number[] }>();
  private readonly gauges = new Map<ReportGaugeName, number>();

  increment(name: ReportCounterName, labels: ReportMetricLabels = {}): void {
    const normalized = metricLabels(labels);
    const key = metricKey(name, normalized);
    const current = this.counters.get(key);
    if (current === undefined) {
      this.counters.set(key, { name, labels: normalized, value: 1 });
    } else {
      current.value += 1;
    }
  }

  observe(
    name: ReportHistogramName,
    value: number,
    labels: ReportMetricLabels = {},
  ): void {
    if (!Number.isFinite(value) || value < 0) return;
    const normalized = metricLabels(labels);
    const key = metricKey(name, normalized);
    const current = this.histograms.get(key);
    if (current === undefined) {
      this.histograms.set(key, { name, labels: normalized, values: [value] });
    } else {
      current.values.push(value);
    }
  }

  setGauge(name: ReportGaugeName, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    this.gauges.set(name, value);
  }

  snapshot(): ReportMetricSnapshot {
    return {
      counters: [...this.counters.values()].map((metric) => ({ ...metric })),
      histograms: [...this.histograms.values()].map((metric) => ({
        ...metric,
        values: [...metric.values],
      })),
      gauges: [...this.gauges].map(([name, value]) => ({ name, value })),
    };
  }
}

export class DefaultReportTelemetry implements ReportTelemetry {
  constructor(
    private readonly logger: ReportLogger,
    private readonly metrics: ReportMetrics,
  ) {}

  emit(event: ReportEvent, fields: ReportOperationalFields = {}): void {
    this.logger.log(event, fields);
    const labels = metricLabels(fields);
    this.recordEventCounter(event, labels);
    if (fields.durationMs !== undefined) {
      this.metrics.observe(
        event === REPORT_EVENTS.apiRequest
          ? "report_api_duration_ms"
          : "report_stage_duration_ms",
        fields.durationMs,
        labels,
      );
    }
    if (fields.recordCount !== undefined) {
      this.metrics.observe("report_snapshot_records", fields.recordCount, labels);
    }
    if (fields.csvByteSize !== undefined) {
      this.metrics.observe("report_csv_bytes", fields.csvByteSize, labels);
    }
    if (fields.confirmationLatencyMs !== undefined) {
      this.metrics.observe(
        "report_confirmation_latency_ms",
        fields.confirmationLatencyMs,
        labels,
      );
    }
  }

  private recordEventCounter(event: ReportEvent, labels: ReportMetricLabels): void {
    if (event === REPORT_EVENTS.apiRequest) this.metrics.increment("report_api_requests_total", labels);
    if (event === REPORT_EVENTS.jobClaimed || event === REPORT_EVENTS.jobRetried) this.metrics.increment("report_worker_jobs_total", labels);
    if (event === REPORT_EVENTS.snapshotCommitted) this.metrics.increment("report_snapshots_total", labels);
    if (event === REPORT_EVENTS.csvGenerated) this.metrics.increment("report_csv_generated_total", labels);
    if (event.startsWith("provider_submission_")) this.metrics.increment("report_provider_attempts_total", labels);
    if (event.startsWith("webhook_")) this.metrics.increment("report_webhooks_total", labels);
    if (event === REPORT_EVENTS.deadlineFailure) this.metrics.increment("report_deadline_failures_total", labels);
    if (event === REPORT_EVENTS.retryCreated) this.metrics.increment("report_retries_total", labels);
    if (event === REPORT_EVENTS.requestBlocked) this.metrics.increment("report_conflicts_total", labels);
    if (event === REPORT_EVENTS.terminalTransition) this.metrics.increment("report_terminal_total", labels);
  }
}

export function hashReportEmail(email: string): string {
  return createHash("sha256")
    .update(email.trim().toLowerCase(), "utf8")
    .digest("hex");
}

export function reportDurationMs(startedAt: number): number {
  return Math.max(0, performance.now() - startedAt);
}

function metricLabels(fields: ReportOperationalFields): ReportMetricLabels {
  const labels: Record<string, string> = {};
  for (const name of METRIC_LABEL_NAMES) {
    const value = fields[name];
    if (typeof value === "string") labels[name] = value;
  }
  return labels;
}

function metricKey(
  name: ReportCounterName | ReportHistogramName,
  labels: ReportMetricLabels,
): string {
  return `${name}:${JSON.stringify(labels)}`;
}

export const reportMetrics = new InMemoryReportMetrics();
export const reportTelemetry: ReportTelemetry = new DefaultReportTelemetry(
  new JsonReportLogger(),
  reportMetrics,
);

export const silentReportTelemetry: ReportTelemetry = Object.freeze({
  emit: () => undefined,
});
