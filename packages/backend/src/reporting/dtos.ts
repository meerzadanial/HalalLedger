import type {
  ReportFailureStage,
  ReportProgressStage,
  ReportStatus,
  ReportType,
} from "./constants";
import type { ReportPeriod } from "./models";
import type { ReportDateString, UtcTimestampString } from "./temporal";

export type ReportFieldName =
  | "reportType"
  | "referenceDate"
  | "clientRequestId"
  | "reportRequestId";

export type ReportFieldErrors = Readonly<
  Partial<Record<ReportFieldName, string>>
>;

/** The complete allowlist for a failure exposed outside the backend. */
export interface PublicReportFailure {
  readonly code: string;
  readonly stage?: ReportFailureStage;
  readonly message: string;
  readonly fieldErrors?: ReportFieldErrors;
}

export interface ResolveReportPeriodDto {
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriod;
  readonly accountEmail: string;
  readonly timeZone: string;
}

export interface ReportRequestDto {
  readonly id: string;
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriod;
  readonly accountEmail: string;
  readonly status: ReportStatus;
  readonly progressStage: ReportProgressStage;
  readonly createdAt: UtcTimestampString;
  readonly providerAcceptedAt: UtcTimestampString | null;
  readonly sentAt: UtcTimestampString | null;
  readonly failure: PublicReportFailure | null;
  readonly canRetry: boolean;
}

export interface ReportInProgressDto extends PublicReportFailure {
  readonly code: "report_in_progress";
  readonly activeRequest: ReportRequestDto;
}
