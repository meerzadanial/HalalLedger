import { Temporal } from "@js-temporal/polyfill";
import { isReportType, type ReportType } from "./constants";
import { ReportPeriodResolutionError } from "./errors";
import type { Clock } from "./infrastructure";
import type { ReportPeriod } from "./models";
import {
  REPORT_DATE_PATTERN,
  asReportDateString,
  type ReportDateString,
} from "./temporal";

export interface ResolveReportPeriodInput {
  readonly reportType?: unknown;
  readonly referenceDate?: unknown;
  /** The authoritative IANA time zone stored on the authenticated account. */
  readonly timeZone: string;
}

export interface ResolvedReportPeriod {
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriod;
}

/** Pure calendar-period resolution with all time access supplied by the clock. */
export class ReportPeriodResolver {
  constructor(private readonly clock: Clock) {}

  resolve(input: ResolveReportPeriodInput): ResolvedReportPeriod {
    if (!isReportType(input.reportType)) {
      throw new ReportPeriodResolutionError("report_type");
    }

    const reference = parseReferenceDate(input.referenceDate);
    const current = currentPlainDate(this.clock, input.timeZone);
    if (Temporal.PlainDate.compare(reference, current) > 0) {
      throw new ReportPeriodResolutionError("future_date");
    }

    const period = input.reportType === "weekly"
      ? resolveWeek(reference)
      : resolveMonth(reference);

    return {
      reportType: input.reportType,
      referenceDate: toReportDateString(reference),
      period,
    };
  }
}
function parseReferenceDate(value: unknown): Temporal.PlainDate {
  if (value === undefined || value === null || value === "") {
    throw new ReportPeriodResolutionError("missing");
  }
  if (typeof value !== "string") {
    throw new ReportPeriodResolutionError("malformed");
  }
  if (/^(?:0000|-\d{6})-\d{2}-\d{2}$/.test(value)) {
    throw new ReportPeriodResolutionError("pre_range");
  }
  if (!REPORT_DATE_PATTERN.test(value)) {
    throw new ReportPeriodResolutionError("malformed");
  }

  const [year, month, day] = value.split("-").map(Number);
  try {
    return Temporal.PlainDate.from({ year, month, day }, { overflow: "reject" });
  } catch (cause) {
    if (cause instanceof RangeError) {
      throw new ReportPeriodResolutionError("nonexistent");
    }
    throw cause;
  }
}

function currentPlainDate(clock: Clock, timeZone: string): Temporal.PlainDate {
  const now = clock.now();
  if (!Number.isFinite(now.getTime())) {
    throw new RangeError("Clock must return a valid instant");
  }
  return Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate();
}

function resolveWeek(reference: Temporal.PlainDate): ReportPeriod {
  const start = reference.subtract({ days: reference.dayOfWeek - 1 });
  return makePeriod(start, start.add({ days: 6 }));
}

function resolveMonth(reference: Temporal.PlainDate): ReportPeriod {
  const start = reference.with({ day: 1 });
  return makePeriod(start, reference.with({ day: reference.daysInMonth }));
}

function makePeriod(
  start: Temporal.PlainDate,
  end: Temporal.PlainDate,
): ReportPeriod {
  return {
    startDate: toReportDateString(start),
    endDate: toReportDateString(end),
    inclusive: true,
  };
}

function toReportDateString(date: Temporal.PlainDate): ReportDateString {
  const value = asReportDateString(date.toString({ calendarName: "never" }));
  if (value === null) {
    throw new RangeError("Resolved date is outside supported years 0001-9999");
  }
  return value;
}
