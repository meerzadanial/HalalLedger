import type { ReportMetricSnapshot } from "./observability";
import type { ReportAlertThresholds } from "./operationalConfig";

export interface ReportAlertStates {
  readonly staleLeases: boolean;
  readonly failureSpike: boolean;
  readonly invalidSignatureSpike: boolean;
  readonly approachingDeadlines: boolean;
}

/** Derives alert states from an exporter/window's metric snapshot and config. */
export function deriveReportAlertStates(
  snapshot: ReportMetricSnapshot,
  thresholds: ReportAlertThresholds,
): ReportAlertStates {
  return {
    staleLeases: gauge(snapshot, "report_stale_leases") >= thresholds.staleLeaseCount,
    failureSpike: counter(snapshot, "report_terminal_total", {
      statusTo: "failed",
    }) >= thresholds.failureSpikeCount,
    invalidSignatureSpike: counter(snapshot, "report_webhooks_total", {
      errorCode: "invalid_provider_signature",
    }) >= thresholds.invalidSignatureSpikeCount,
    approachingDeadlines: gauge(snapshot, "report_approaching_deadlines") >=
      thresholds.approachingDeadlineCount,
  };
}

function gauge(
  snapshot: ReportMetricSnapshot,
  name: "report_stale_leases" | "report_approaching_deadlines",
): number {
  return snapshot.gauges.find((metric) => metric.name === name)?.value ?? 0;
}

function counter(
  snapshot: ReportMetricSnapshot,
  name: "report_terminal_total" | "report_webhooks_total",
  labels: Readonly<Record<string, string>>,
): number {
  return snapshot.counters
    .filter((metric) => metric.name === name)
    .filter((metric) => Object.entries(labels).every(
      ([key, value]) => metric.labels[key as keyof typeof metric.labels] === value,
    ))
    .reduce((total, metric) => total + metric.value, 0);
}
