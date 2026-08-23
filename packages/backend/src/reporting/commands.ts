import type { ReportType } from "./constants";
import type { ReportDateString } from "./temporal";

/** Inputs authorized by the application layer before period resolution. */
export interface ResolveReportPeriodCommand {
  readonly userId: string;
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
}

/**
 * Deliberately excludes recipient, timezone, boundaries, lifecycle state, and
 * failure details. Those values are always derived by the server.
 */
export interface CreateReportRequestCommand {
  readonly userId: string;
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly clientRequestId: string;
}

/** Retries identify the immutable failed request; its selection is server-read. */
export interface RetryReportRequestCommand {
  readonly userId: string;
  readonly reportRequestId: string;
  readonly clientRequestId: string;
}

/** Raw JSON accepted by the create route before validation and branding. */
export interface CreateReportRequestWireCommand {
  readonly reportType?: unknown;
  readonly referenceDate?: unknown;
  readonly clientRequestId?: unknown;
}

/** Raw JSON accepted by the retry route before validation. */
export interface RetryReportRequestWireCommand {
  readonly clientRequestId?: unknown;
}
