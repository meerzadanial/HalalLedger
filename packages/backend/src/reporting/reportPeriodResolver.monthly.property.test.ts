import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReportPeriodResolver, type Clock } from "./index";

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

interface TimeZoneCase {
  readonly name: string;
  readonly offsetMinutes: number;
}

class FixedClock implements Clock {
  constructor(private readonly instant: Date) {}

  now(): Date {
    return new Date(this.instant.getTime());
  }
}

const TIME_ZONES: readonly TimeZoneCase[] = [
  { name: "UTC", offsetMinutes: 0 },
  { name: "Asia/Kuala_Lumpur", offsetMinutes: 8 * 60 },
  { name: "Asia/Kathmandu", offsetMinutes: 5 * 60 + 45 },
  { name: "Pacific/Kiritimati", offsetMinutes: 14 * 60 },
  { name: "Pacific/Pago_Pago", offsetMinutes: -11 * 60 },
];

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  const lengths = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return lengths[month - 1];
}

function formatDate(date: CivilDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function instantAtLocalDate(date: CivilDate, offsetMinutes: number, localSecond: number): Date {
  const localMidnightUtc = new Date(`${formatDate(date)}T00:00:00Z`).getTime();
  return new Date(localMidnightUtc + localSecond * 1_000 - offsetMinutes * 60_000);
}

function validDateArbitrary(minYear: number, maxYear: number): fc.Arbitrary<CivilDate> {
  return fc.record({
    year: fc.integer({ min: minYear, max: maxYear }),
    month: fc.integer({ min: 1, max: 12 }),
  }).chain(({ year, month }) => fc.integer({
    min: 1,
    max: daysInMonth(year, month),
  }).map((day) => ({ year, month, day })));
}

const monthBoundaryArbitrary = fc.record({
  year: fc.integer({ min: 1, max: 9_999 }),
  month: fc.integer({ min: 1, max: 12 }),
}).chain(({ year, month }) => fc.constantFrom<CivilDate>(
  { year, month, day: 1 },
  { year, month, day: daysInMonth(year, month) },
));

const leapBoundaryArbitrary = fc.integer({ min: 1, max: 9_999 })
  .filter(isLeapYear)
  .chain((year) => fc.constantFrom<CivilDate>(
    { year, month: 2, day: 28 },
    { year, month: 2, day: 29 },
    { year, month: 3, day: 1 },
  ));

const yearBoundaryArbitrary = fc.integer({ min: 1, max: 9_999 })
  .chain((year) => fc.constantFrom<CivilDate>(
    { year, month: 1, day: 1 },
    { year, month: 12, day: 31 },
  ));

function expectMonthlyResolution(reference: CivilDate, clockInstant: Date, timeZone: string): void {
  const resolved = new ReportPeriodResolver(new FixedClock(clockInstant)).resolve({
    reportType: "monthly",
    referenceDate: formatDate(reference),
    timeZone,
  });
  const expectedStart = { year: reference.year, month: reference.month, day: 1 };
  const expectedEnd = {
    year: reference.year,
    month: reference.month,
    day: daysInMonth(reference.year, reference.month),
  };

  expect(resolved.period).toEqual({
    startDate: formatDate(expectedStart),
    endDate: formatDate(expectedEnd),
    inclusive: true,
  });
  expect(resolved.period.startDate.slice(0, 7)).toBe(formatDate(reference).slice(0, 7));
  expect(resolved.period.endDate.slice(0, 7)).toBe(formatDate(reference).slice(0, 7));
}

describe("ReportPeriodResolver monthly calendar boundaries", () => {
  // Feature: bulk-csv-report-email, Property 3: Monthly calendar boundaries
  // **Validates: Requirements 2.3, 2.4**
  it("matches an independent Gregorian first-to-last-day model", () => {
    fc.assert(fc.property(fc.record({
      generalDate: validDateArbitrary(1, 9_999),
      monthBoundary: monthBoundaryArbitrary,
      leapBoundary: leapBoundaryArbitrary,
      yearBoundary: yearBoundaryArbitrary,
      currentDate: validDateArbitrary(2_000, 2_035),
      timeZone: fc.constantFrom<TimeZoneCase>(...TIME_ZONES),
      localSecond: fc.constantFrom(0, 1, 43_200, 86_398, 86_399),
    }), ({ generalDate, monthBoundary, leapBoundary, yearBoundary, currentDate, timeZone, localSecond }) => {
      for (const reference of [generalDate, monthBoundary, leapBoundary, yearBoundary]) {
        expectMonthlyResolution(reference, new Date(`${formatDate(reference)}T12:00:00Z`), "UTC");
      }
      expectMonthlyResolution(
        currentDate,
        instantAtLocalDate(currentDate, timeZone.offsetMinutes, localSecond),
        timeZone.name,
      );
    }), { numRuns: 200 });
  });
});
