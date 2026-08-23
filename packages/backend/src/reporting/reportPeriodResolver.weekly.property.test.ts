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

function dayOfYear(date: CivilDate): number {
  let result = date.day;
  for (let month = 1; month < date.month; month += 1) {
    result += daysInMonth(date.year, month);
  }
  return result;
}
function ordinal(date: CivilDate): number {
  const priorYear = date.year - 1;
  return priorYear * 365
    + Math.floor(priorYear / 4)
    - Math.floor(priorYear / 100)
    + Math.floor(priorYear / 400)
    + dayOfYear(date) - 1;
}

function dayOfWeek(date: CivilDate): number {
  return ordinal(date) % 7 + 1;
}

function shiftDate(date: CivilDate, amount: number): CivilDate {
  let current = { ...date };
  const direction = Math.sign(amount);
  for (let remaining = Math.abs(amount); remaining > 0; remaining -= 1) {
    if (direction > 0) {
      current = current.day < daysInMonth(current.year, current.month)
        ? { ...current, day: current.day + 1 }
        : current.month < 12
          ? { year: current.year, month: current.month + 1, day: 1 }
          : { year: current.year + 1, month: 1, day: 1 };
    } else {
      current = current.day > 1
        ? { ...current, day: current.day - 1 }
        : current.month > 1
          ? { year: current.year, month: current.month - 1, day: daysInMonth(current.year, current.month - 1) }
          : { year: current.year - 1, month: 12, day: 31 };
    }
  }
  return current;
}

function weeklyBoundaryModel(reference: CivilDate): { start: CivilDate; end: CivilDate } {
  const start = shiftDate(reference, -(dayOfWeek(reference) - 1));
  return { start, end: shiftDate(start, 6) };
}

function formatDate(date: CivilDate): string {
  return `${date.year.toString().padStart(4, "0")}-${date.month.toString().padStart(2, "0")}-${date.day.toString().padStart(2, "0")}`;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}
function instantAtLocalDate(
  localDate: CivilDate,
  offsetMinutes: number,
  localSecond: number,
): Date {
  const utcSeconds = localSecond - offsetMinutes * 60;
  const dayShift = Math.floor(utcSeconds / 86_400);
  const secondOfUtcDay = positiveModulo(utcSeconds, 86_400);
  const utcDate = shiftDate(localDate, dayShift);
  const hour = Math.floor(secondOfUtcDay / 3_600);
  const minute = Math.floor(secondOfUtcDay % 3_600 / 60);
  const second = secondOfUtcDay % 60;
  return new Date(`${formatDate(utcDate)}T${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}:${second.toString().padStart(2, "0")}Z`);
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

const leapBoundaryArbitrary = fc.integer({ min: 1, max: 9_998 })
  .filter(isLeapYear)
  .chain((year) => fc.constantFrom<CivilDate>(
    { year, month: 2, day: 28 },
    { year, month: 2, day: 29 },
    { year, month: 3, day: 1 },
  ));

const monthBoundaryArbitrary = fc.record({
  year: fc.integer({ min: 1, max: 9_998 }),
  month: fc.integer({ min: 1, max: 12 }),
}).chain(({ year, month }) => fc.constantFrom<CivilDate>(
  { year, month, day: 1 },
  { year, month, day: daysInMonth(year, month) },
));

const yearBoundaryArbitrary = fc.integer({ min: 1, max: 9_998 })
  .chain((year) => fc.constantFrom<CivilDate>(
    { year, month: 1, day: 1 },
    { year, month: 12, day: 31 },
  ));
function expectWeeklyResolution(
  reference: CivilDate,
  timeZone: TimeZoneCase,
  localSecond: number,
): void {
  const expected = weeklyBoundaryModel(reference);
  const resolver = new ReportPeriodResolver(new FixedClock(
    instantAtLocalDate(reference, timeZone.offsetMinutes, localSecond),
  ));
  const resolved = resolver.resolve({
    reportType: "weekly",
    referenceDate: formatDate(reference),
    timeZone: timeZone.name,
  });

  expect(resolved.period).toEqual({
    startDate: formatDate(expected.start),
    endDate: formatDate(expected.end),
    inclusive: true,
  });
  expect(dayOfWeek(expected.start)).toBe(1);
  expect(dayOfWeek(expected.end)).toBe(7);
  expect(ordinal(expected.start)).toBeLessThanOrEqual(ordinal(reference));
  expect(ordinal(expected.end)).toBeGreaterThanOrEqual(ordinal(reference));
  expect(ordinal(expected.end) - ordinal(expected.start) + 1).toBe(7);
}

describe("ReportPeriodResolver weekly calendar boundaries", () => {
  // Feature: bulk-csv-report-email, Property 2: Weekly calendar boundaries
  // **Validates: Requirements 2.1, 2.2**
  it("matches an independent Gregorian Monday-Sunday model", () => {
    fc.assert(fc.property(fc.record({
      leapBoundary: leapBoundaryArbitrary,
      monthBoundary: monthBoundaryArbitrary,
      yearBoundary: yearBoundaryArbitrary,
      generalDate: validDateArbitrary(1, 9_998),
      timeZone: fc.constantFrom<TimeZoneCase>(...TIME_ZONES),
      currentDate: validDateArbitrary(2_000, 2_035),
      localSecond: fc.constantFrom(0, 1, 43_200, 86_398, 86_399),
    }), ({
      leapBoundary,
      monthBoundary,
      yearBoundary,
      generalDate,
      timeZone,
      currentDate,
      localSecond,
    }) => {
      const utc = TIME_ZONES[0];
      for (const reference of [leapBoundary, monthBoundary, yearBoundary, generalDate]) {
        expectWeeklyResolution(reference, utc, localSecond);
      }
      expectWeeklyResolution(currentDate, timeZone, localSecond);
    }), { numRuns: 200 });
  });
});
