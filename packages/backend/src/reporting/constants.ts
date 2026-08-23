export const REPORT_TYPES = Object.freeze(["weekly", "monthly"] as const);
export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_STATUSES = Object.freeze([
  "pending",
  "processing",
  "email_submitted",
  "email_accepted",
  "sent",
  "failed",
] as const);
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const TERMINAL_REPORT_STATUSES = Object.freeze([
  "sent",
  "failed",
] as const satisfies readonly ReportStatus[]);
export type TerminalReportStatus = (typeof TERMINAL_REPORT_STATUSES)[number];

export const REPORT_PROGRESS_STAGES = Object.freeze([
  "data_retrieval",
  "snapshot",
  "csv_generation",
  "email_submission",
  "delivery_wait",
] as const);
export type ReportProgressStage = (typeof REPORT_PROGRESS_STAGES)[number];

export const REPORT_FAILURE_STAGES = Object.freeze([
  "data_retrieval",
  "snapshot",
  "csv_generation",
  "report_size",
  "email_submission",
  "unexpected",
] as const);
export type ReportFailureStage = (typeof REPORT_FAILURE_STAGES)[number];

export const PROVIDER_EVENT_TYPES = Object.freeze([
  "delivered",
  "failed",
  "bounced",
  "suppressed",
] as const);
export type ProviderEventType = (typeof PROVIDER_EVENT_TYPES)[number];

export const REPORT_CURRENCY = "MYR" as const;
export const REPORT_CSV_MEDIA_TYPE = "text/csv; charset=UTF-8" as const;
export const REPORT_ATTACHMENT_LIMIT_BYTES = 10_485_760 as const;

export function isReportType(value: unknown): value is ReportType {
  return typeof value === "string" && REPORT_TYPES.includes(value as ReportType);
}

export function isReportStatus(value: unknown): value is ReportStatus {
  return (
    typeof value === "string" && REPORT_STATUSES.includes(value as ReportStatus)
  );
}

export function isTerminalReportStatus(
  status: ReportStatus,
): status is TerminalReportStatus {
  return TERMINAL_REPORT_STATUSES.includes(status as TerminalReportStatus);
}
