import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ReportPeriodResolutionError,
  ReportPeriodResolver,
  type Clock,
  type ReportPeriodErrorReason,
} from "./index";

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface ExpectedInvalid {
  readonly reason: ReportPeriodErrorReason;
  readonly code:
    | "missing_reference_date"
    | "invalid_reference_date"
    | "future_reference_date";
}

class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

const TIME_ZONES = [
  "UTC",
  "Asia/Kuala_Lumpur",
  "Asia/Kathmandu",
  "America/New_York",
  "Pacific/Kiritimati",
  "Pacific/Pago_Pago",
] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function formatDate(date: CivilDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function localDateAt(instant: Date, timeZone: string): CivilDate {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);
  const value = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: value("year"), month: value("month"), day: value("day") };
}

function addDays(date: CivilDate, amount: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function ordinal(date: CivilDate): number {
  const priorYear = date.year - 1;
  let days = priorYear * 365
    + Math.floor(priorYear / 4)
    - Math.floor(priorYear / 100)
    + Math.floor(priorYear / 400)
    + date.day - 1;
  for (let month = 1; month < date.month; month += 1) {
    days += daysInMonth(date.year, month);
  }
  return days;
}

function invalidInputModel(value: unknown, currentDate: CivilDate): ExpectedInvalid {
  if (value === undefined || value === null || value === "") {
    return { reason: "missing", code: "missing_reference_date" };
  }
  if (typeof value !== "string") {
    return { reason: "malformed", code: "invalid_reference_date" };
  }
  if (/^(?:0000|-\d{6})-\d{2}-\d{2}$/.test(value)) {
    return { reason: "pre_range", code: "invalid_reference_date" };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return { reason: "malformed", code: "invalid_reference_date" };
  }

  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { reason: "nonexistent", code: "invalid_reference_date" };
  }
  if (ordinal({ year, month, day }) > ordinal(currentDate)) {
    return { reason: "future_date", code: "future_reference_date" };
  }
  throw new Error("Independent invalid-input model received a valid date");
}
const nonexistentDateArbitrary = fc.record({
  year: fc.integer({ min: 1, max: 9_999 }),
  month: fc.integer({ min: 1, max: 12 }),
}).chain(({ year, month }) => fc.integer({
  min: daysInMonth(year, month) + 1,
  max: 99,
}).map((day) => formatDate({ year, month, day })));

const preRangeDateArbitrary = fc.oneof(
  fc.constant("0000-12-31"),
  fc.integer({ min: 1, max: 999_999 }).map((year) =>
    `-${year.toString().padStart(6, "0")}-01-01`),
);

const upperOutOfRangeDateArbitrary = fc.integer({ min: 10_000, max: 999_999 })
  .map((year) => `${year}-01-01`);

describe("ReportPeriodResolver rejected reference dates", () => {
  // Feature: bulk-csv-report-email, Property 4: Invalid references cannot replace valid resolution
  // **Validates: Requirements 2.6, 2.7**
  it("rejects independently modeled invalid references and preserves the prior resolution", () => {
    fc.assert(fc.property(fc.record({
      reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
      timeZone: fc.constantFrom(...TIME_ZONES),
      instant: fc.date({
        min: new Date("2000-01-01T00:00:00.000Z"),
        max: new Date("2035-12-31T23:59:59.999Z"),
        noInvalidDate: true,
      }),
      absent: fc.constantFrom<undefined | null | "">(undefined, null, ""),
      preRange: preRangeDateArbitrary,
      upperOutOfRange: upperOutOfRangeDateArbitrary,
      nonexistent: nonexistentDateArbitrary,
      futureDays: fc.integer({ min: 1, max: 730 }),
    }), ({
      reportType,
      timeZone,
      instant,
      absent,
      preRange,
      upperOutOfRange,
      nonexistent,
      futureDays,
    }) => {
      const resolver = new ReportPeriodResolver(new FixedClock(instant));
      const currentDate = localDateAt(instant, timeZone);
      let displayedPeriod = resolver.resolve({
        reportType,
        referenceDate: formatDate(currentDate),
        timeZone,
      }).period;
      const priorPeriod = displayedPeriod;
      const invalidReferences: readonly unknown[] = [
        absent,
        preRange,
        upperOutOfRange,
        nonexistent,
        formatDate(addDays(currentDate, futureDays)),
      ];

      for (const referenceDate of invalidReferences) {
        const expected = invalidInputModel(referenceDate, currentDate);
        let thrown: unknown;
        try {
          displayedPeriod = resolver.resolve({ reportType, referenceDate, timeZone }).period;
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(ReportPeriodResolutionError);
        const resolutionError = thrown as ReportPeriodResolutionError;
        expect(resolutionError.reason).toBe(expected.reason);
        expect(resolutionError.code).toBe(expected.code);
        expect(resolutionError.httpStatus).toBe(400);
        expect(resolutionError.fieldErrors?.referenceDate).toEqual(expect.any(String));
        expect(displayedPeriod).toBe(priorPeriod);
      }
    }), { numRuns: 200 });
  });
});
