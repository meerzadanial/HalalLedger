import type {
  PublicReportFailure,
  ReportFieldErrors,
  ReportRequestDto,
} from "./dtos";
import type { ReportFailureStage } from "./constants";

type RetryClassification = "never" | "transient";

interface ErrorDefinition {
  readonly message: string;
  readonly stage?: ReportFailureStage;
  readonly httpStatus: 400 | 401 | 404 | 409 | 413 | 500 | 502 | 503 | 504;
  readonly retry: RetryClassification;
}

/**
 * Single authoritative catalog for report errors. Messages are fixed and safe;
 * arbitrary exception text is never copied into a public response.
 */
export const REPORT_ERROR_DEFINITIONS = {
  authentication_required: {
    message: "Authentication is required to perform this report action.",
    httpStatus: 401,
    retry: "never",
  },
  invalid_report_type: {
    message: "Report type must be weekly or monthly.",
    httpStatus: 400,
    retry: "never",
  },
  missing_reference_date: {
    message: "A reference date is required.",
    httpStatus: 400,
    retry: "never",
  },
  invalid_reference_date: {
    message: "Reference date must be a valid date in YYYY-MM-DD format.",
    httpStatus: 400,
    retry: "never",
  },
  future_reference_date: {
    message: "Future reference dates are not permitted.",
    httpStatus: 400,
    retry: "never",
  },
  invalid_client_request_id: {
    message: "Client request ID must be a valid UUID.",
    httpStatus: 400,
    retry: "never",
  },
  idempotency_conflict: {
    message: "This client request ID was already used for a different report.",
    httpStatus: 409,
    retry: "never",
  },
  report_in_progress: {
    message: "A report request is already in progress.",
    httpStatus: 409,
    retry: "never",
  },
  report_not_found: {
    message: "Report request was not found.",
    httpStatus: 404,
    retry: "never",
  },
  retry_not_allowed: {
    message: "Only a failed report request can be retried.",
    httpStatus: 409,
    retry: "never",
  },
  data_retrieval_failed: {
    message: "Report data retrieval failed.",
    stage: "data_retrieval",
    httpStatus: 500,
    retry: "transient",
  },
  snapshot_failed: {
    message: "Report snapshot creation failed.",
    stage: "snapshot",
    httpStatus: 500,
    retry: "transient",
  },
  csv_generation_failed: {
    message: "CSV report generation failed.",
    stage: "csv_generation",
    httpStatus: 500,
    retry: "never",
  },
  missing_required_cash_amount: {
    message: "CSV report generation failed because required cash data is missing.",
    stage: "csv_generation",
    httpStatus: 500,
    retry: "never",
  },
  report_too_large: {
    message: "The report exceeds the permitted attachment size.",
    stage: "report_size",
    httpStatus: 413,
    retry: "never",
  },
  email_submission_failed: {
    message: "Report email submission failed.",
    stage: "email_submission",
    httpStatus: 502,
    retry: "transient",
  },
  provider_unavailable: {
    message: "Report email submission is temporarily unavailable.",
    stage: "email_submission",
    httpStatus: 503,
    retry: "transient",
  },
  provider_rejected: {
    message: "The email provider rejected the report email.",
    stage: "email_submission",
    httpStatus: 502,
    retry: "never",
  },
  provider_response_invalid: {
    message: "The email provider returned an invalid response.",
    stage: "email_submission",
    httpStatus: 502,
    retry: "transient",
  },
  delivery_timeout: {
    message: "Report delivery was not confirmed before the delivery deadline.",
    stage: "email_submission",
    httpStatus: 504,
    retry: "never",
  },
  invalid_provider_signature: {
    message: "Provider webhook signature is invalid.",
    httpStatus: 401,
    retry: "never",
  },
  malformed_provider_event: {
    message: "Provider webhook event is malformed.",
    httpStatus: 400,
    retry: "never",
  },
  provider_event_persistence_failed: {
    message: "Provider webhook processing is temporarily unavailable.",
    httpStatus: 503,
    retry: "transient",
  },
  unexpected_report_error: {
    message: "The report could not be completed because of an unexpected error.",
    stage: "unexpected",
    httpStatus: 500,
    retry: "never",
  },
} as const satisfies Record<string, ErrorDefinition>;

export type ReportErrorCode = keyof typeof REPORT_ERROR_DEFINITIONS;
export const REPORT_ERROR_CODES = Object.freeze(
  Object.keys(REPORT_ERROR_DEFINITIONS) as ReportErrorCode[],
);

export interface ReportDomainErrorOptions {
  readonly fieldErrors?: ReportFieldErrors;
  readonly cause?: unknown;
}
export class ReportDomainError<
  Code extends ReportErrorCode = ReportErrorCode,
> extends Error {
  readonly code: Code;
  readonly stage?: ReportFailureStage;
  readonly httpStatus: ErrorDefinition["httpStatus"];
  readonly retry: RetryClassification;
  readonly fieldErrors?: ReportFieldErrors;

  constructor(code: Code, options: ReportDomainErrorOptions = {}) {
    const definition: ErrorDefinition = REPORT_ERROR_DEFINITIONS[code];
    super(definition.message, { cause: options.cause });
    this.name = "ReportDomainError";
    this.code = code;
    this.stage = definition.stage;
    this.httpStatus = definition.httpStatus;
    this.retry = definition.retry;
    this.fieldErrors = options.fieldErrors;
  }

  toPublicFailure(): PublicReportFailure {
    const definition: ErrorDefinition = REPORT_ERROR_DEFINITIONS[this.code];
    return {
      code: this.code,
      ...(definition.stage === undefined ? {} : { stage: definition.stage }),
      message: definition.message,
      ...(this.fieldErrors === undefined
        ? {}
        : { fieldErrors: { ...this.fieldErrors } }),
    };
  }
}

export function isReportDomainError(
  error: unknown,
): error is ReportDomainError {
  return error instanceof ReportDomainError;
}

/** A conflict that safely carries only the authenticated user's active DTO. */
export class ReportInProgressError extends ReportDomainError<"report_in_progress"> {
  readonly activeRequest: ReportRequestDto;

  constructor(activeRequest: ReportRequestDto) {
    super("report_in_progress");
    this.name = "ReportInProgressError";
    this.activeRequest = activeRequest;
  }
}

export const REPORT_PERIOD_ERROR_REASONS = Object.freeze([
  "missing",
  "malformed",
  "nonexistent",
  "pre_range",
  "future_date",
  "report_type",
] as const);
export type ReportPeriodErrorReason =
  (typeof REPORT_PERIOD_ERROR_REASONS)[number];

const REPORT_PERIOD_ERROR_DETAILS = {
  missing: {
    code: "missing_reference_date",
    fieldErrors: { referenceDate: "A reference date is required." },
  },
  malformed: {
    code: "invalid_reference_date",
    fieldErrors: { referenceDate: "Use the YYYY-MM-DD date format." },
  },
  nonexistent: {
    code: "invalid_reference_date",
    fieldErrors: { referenceDate: "Enter an existing Gregorian calendar date." },
  },
  pre_range: {
    code: "invalid_reference_date",
    fieldErrors: { referenceDate: "Date must be on or after 0001-01-01." },
  },
  future_date: {
    code: "future_reference_date",
    fieldErrors: { referenceDate: "Future dates are not permitted." },
  },
  report_type: {
    code: "invalid_report_type",
    fieldErrors: { reportType: "Select weekly or monthly." },
  },
} as const;

/** A safe, discriminated validation failure shared by preview and creation. */
export class ReportPeriodResolutionError extends ReportDomainError<
  | "invalid_report_type"
  | "missing_reference_date"
  | "invalid_reference_date"
  | "future_reference_date"
> {
  readonly reason: ReportPeriodErrorReason;

  constructor(reason: ReportPeriodErrorReason) {
    const details = REPORT_PERIOD_ERROR_DETAILS[reason];
    super(details.code, { fieldErrors: details.fieldErrors });
    this.name = "ReportPeriodResolutionError";
    this.reason = reason;
  }
}

/**
 * Safe boundary projection. Unknown errors intentionally collapse to one fixed
 * response and cannot leak messages, stacks, credentials, payloads, or causes.
 */
export function toPublicReportFailure(error: unknown): PublicReportFailure {
  if (isReportDomainError(error)) {
    return error.toPublicFailure();
  }

  return new ReportDomainError("unexpected_report_error").toPublicFailure();
}
