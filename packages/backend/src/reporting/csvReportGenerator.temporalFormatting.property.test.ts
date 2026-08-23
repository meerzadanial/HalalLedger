import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot } from "./models";
import type { ReportDateString } from "./temporal";

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const UTC_SECOND_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MIN_INSTANT_MS = new Date("0001-01-01T00:00:00.000Z").getTime();
const MAX_INSTANT_MS = new Date("9999-12-31T23:59:59.999Z").getTime();

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1] ?? 0;
}

const supportedDateArbitrary: fc.Arbitrary<CivilDate> = fc
  .record({
    year: fc.integer({ min: 1, max: 9_999 }),
    month: fc.integer({ min: 1, max: 12 }),
  })
  .chain(({ year, month }) =>
    fc.integer({ min: 1, max: daysInMonth(year, month) }).map((day) => ({
      year,
      month,
      day,
    })),
  );

const validInstantArbitrary = fc
  .integer({ min: MIN_INSTANT_MS, max: MAX_INSTANT_MS })
  .map((milliseconds) => new Date(milliseconds));

function formatCivilDate(value: CivilDate): ReportDateString {
  return [
    value.year.toString().padStart(4, "0"),
    value.month.toString().padStart(2, "0"),
    value.day.toString().padStart(2, "0"),
  ].join("-") as ReportDateString;
}

function parseCanonicalDate(value: string): CivilDate | null {
  if (!DATE_PATTERN.test(value)) {
    return null;
  }
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (
    year < 1 ||
    year > 9_999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }
  return { year, month, day };
}

function parseCanonicalUtcSecond(value: string): number | null {
  const match = UTC_SECOND_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value) ?? [];
  const date = parseCanonicalDate(`${yearText}-${monthText}-${dayText}`);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (date === null || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(date.year, date.month - 1, date.day);
  parsed.setUTCHours(hour, minute, second, 0);
  return parsed.getTime();
}

function requireLabeledValue(records: readonly string[][], label: string): string {
  const row = records.find((candidate) => candidate[0] === label);
  if (row?.[1] === undefined) {
    throw new Error(`Missing CSV value for ${label}`);
  }
  return row[1];
}

function requireDetailValue(
  records: readonly string[][],
  label: string,
): string {
  const headerIndex = records.findIndex((row) => row[0] === "Entry Date");
  const header = records[headerIndex];
  const detail = records[headerIndex + 1];
  const columnIndex = header?.indexOf(label) ?? -1;
  const value = detail?.[columnIndex];
  if (columnIndex < 0 || value === undefined) {
    throw new Error(`Missing CSV detail value for ${label}`);
  }
  return value;
}

function snapshotFor(
  periodStart: CivilDate,
  periodEnd: CivilDate,
  entryDate: CivilDate,
  entryTimestamp: Date,
): ReportSnapshot {
  const zero = new Prisma.Decimal(0);
  return {
    id: "snapshot-property-11",
    reportRequestId: "request-property-11",
    reportType: "weekly",
    period: {
      startDate: formatCivilDate(periodStart),
      endDate: formatCivilDate(periodEnd),
      inclusive: true,
    },
    createdAt: new Date(entryTimestamp.getTime()),
    entries: [
      {
        sourceEntryId: "entry-property-11",
        restaurantName: "Temporal Restaurant",
        restaurantStatus: "halal",
        fareAmount: zero,
        hasCashOrder: false,
        cashAmount: null,
        entryDate: formatCivilDate(entryDate),
        entryTimestamp: new Date(entryTimestamp.getTime()),
      },
    ],
    summary: {
      recordCount: 1,
      digitalIncomeTotal: zero,
      cashIncomeTotal: zero,
      halalIncomeTotal: zero,
      nonHalalIncomeTotal: zero,
    },
  };
}

describe("CsvReportGenerator canonical temporal formatting", () => {
  // Feature: bulk-csv-report-email, Property 11: Canonical temporal formatting
  // **Validates: Requirements 4.17**
  it("round-trips supported dates and arbitrary instants at UTC-second precision", () => {
    fc.assert(
      fc.property(
        fc.record({
          firstPeriodDate: supportedDateArbitrary,
          secondPeriodDate: supportedDateArbitrary,
          entryDate: supportedDateArbitrary,
          entryTimestamp: validInstantArbitrary,
          generationInstant: validInstantArbitrary,
        }),
        ({
          firstPeriodDate,
          secondPeriodDate,
          entryDate,
          entryTimestamp,
          generationInstant,
        }) => {
          const orderedPeriod = [firstPeriodDate, secondPeriodDate].sort(
            (left, right) =>
              formatCivilDate(left).localeCompare(formatCivilDate(right)),
          );
          const periodStart = orderedPeriod[0];
          const periodEnd = orderedPeriod[1];
          if (periodStart === undefined || periodEnd === undefined) {
            throw new Error("The generated period must have two dates");
          }
          const clock: Clock = {
            now: () => new Date(generationInstant.getTime()),
          };
          const attachment = new CsvReportGenerator(clock).generate(
            snapshotFor(periodStart, periodEnd, entryDate, entryTimestamp),
          );
          const records = parse(new TextDecoder().decode(attachment.bytes), {
            relax_column_count: true,
          }) as string[][];

          const renderedDates = [
            [requireLabeledValue(records, "Period Start"), periodStart],
            [requireLabeledValue(records, "Period End"), periodEnd],
            [requireDetailValue(records, "Entry Date"), entryDate],
          ] as const;
          for (const [rendered, source] of renderedDates) {
            expect(rendered).toMatch(DATE_PATTERN);
            expect(parseCanonicalDate(rendered)).toEqual(source);
          }

          const renderedTimestamps = [
            [
              requireDetailValue(records, "Delivery Entry Timestamp"),
              entryTimestamp,
            ],
            [
              requireLabeledValue(records, "Generated At"),
              generationInstant,
            ],
          ] as const;
          for (const [rendered, source] of renderedTimestamps) {
            expect(rendered).toMatch(UTC_SECOND_PATTERN);
            expect(parseCanonicalUtcSecond(rendered)).toBe(
              Math.floor(source.getTime() / 1_000) * 1_000,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});