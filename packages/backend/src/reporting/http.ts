import { randomUUID } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import {
  ReportDomainError,
  ReportInProgressError,
  isReportDomainError,
} from "./errors";

export const REPORT_CORRELATION_HEADER = "x-correlation-id";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReportHttpErrorBody {
  readonly code: string;
  readonly stage?: string;
  readonly message: string;
  readonly fieldErrors?: Readonly<Record<string, string>>;
  readonly activeRequest?: ReportInProgressError["activeRequest"];
  readonly correlationId: string;
}

export interface MappedReportHttpError {
  readonly status: number;
  readonly body: ReportHttpErrorBody;
}

/**
 * Uses a caller correlation ID only when it is a UUID. Arbitrary header values
 * are never reflected into responses or logs.
 */
export function reportCorrelation(
  generate: () => string = randomUUID,
): RequestHandler {
  return (req, res, next) => {
    const supplied = req.header(REPORT_CORRELATION_HEADER);
    const correlationId = supplied && UUID_PATTERN.test(supplied)
      ? supplied.toLowerCase()
      : generate();
    res.locals.reportCorrelationId = correlationId;
    res.setHeader(REPORT_CORRELATION_HEADER, correlationId);
    next();
  };
}

/** Maps every report failure to an allowlisted public response. */
export function mapReportHttpError(
  error: unknown,
  correlationId: string,
): MappedReportHttpError {
  const domainError = isReportDomainError(error)
    ? error
    : new ReportDomainError("unexpected_report_error");
  const failure = domainError.toPublicFailure();
  return {
    status: domainError.httpStatus,
    body: {
      ...failure,
      ...(error instanceof ReportInProgressError
        ? { activeRequest: error.activeRequest }
        : {}),
      correlationId,
    },
  };
}

/** Express boundary that never exposes exception messages, causes, or stacks. */
export const reportErrorHandler: ErrorRequestHandler = (
  error,
  _req,
  res,
  _next,
) => {
  const correlationId = typeof res.locals.reportCorrelationId === "string"
    ? res.locals.reportCorrelationId
    : randomUUID();
  const mapped = mapReportHttpError(error, correlationId);
  res.status(mapped.status).json(mapped.body);
};
