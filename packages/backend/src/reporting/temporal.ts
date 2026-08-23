declare const reportDateBrand: unique symbol;
declare const utcTimestampBrand: unique symbol;

/** A Gregorian API date in the exact YYYY-MM-DD form, years 0001 through 9999. */
export type ReportDateString = string & {
  readonly [reportDateBrand]: "ReportDateString";
};

/** A UTC API timestamp truncated to seconds. */
export type UtcTimestampString = string & {
  readonly [utcTimestampBrand]: "UtcTimestampString";
};

export const REPORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const monthLengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return monthLengths[month - 1] ?? 0;
}

export function isReportDateString(value: unknown): value is ReportDateString {
  if (typeof value !== "string" || !REPORT_DATE_PATTERN.test(value)) {
    return false;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function asReportDateString(value: unknown): ReportDateString | null {
  return isReportDateString(value) ? value : null;
}

export function formatUtcTimestamp(value: Date): UtcTimestampString {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError("A valid instant is required");
  }

  const iso = value.toISOString();
  const year = value.getUTCFullYear();
  if (year < 1 || year > 9999) {
    throw new RangeError("Timestamp year must be between 0001 and 9999");
  }

  return `${iso.slice(0, 19)}Z` as UtcTimestampString;
}
