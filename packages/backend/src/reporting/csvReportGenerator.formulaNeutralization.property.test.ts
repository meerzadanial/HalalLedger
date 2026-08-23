import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportTelemetry } from "./observability";
import type { ReportDateString } from "./temporal";

const TRIGGERS = ["=", "+", "-", "@"] as const;
const NON_TRIGGER_PREFIXES = ["A", "0", " ", "_", ",", '"', "\r", "\n"] as const;
const CSV_SPECIAL_SUFFIXES = [",", '"', "\r", "\n"] as const;
const reportDate = (value: string) => value as ReportDateString;
const zero = () => new Prisma.Decimal("0.00");
const clock: Clock = { now: () => new Date("2025-01-13T01:02:03.987Z") };
const telemetry: ReportTelemetry = { emit: () => undefined };
const suffixArbitrary = fc
  .array(fc.constantFrom("a", "Z", "0", " ", "'", "=", "+", "-", "@", ",", '"', "\r", "\n", "é", "界", "🙂"), {
    maxLength: 24,
  })
  .map((characters) => characters.join(""));

function entry(restaurantName: string, index: number): ReportSnapshotEntry {
  return {
    sourceEntryId: `entry-${index.toString().padStart(2, "0")}`,
    restaurantName,
    restaurantStatus: "halal",
    fareAmount: zero(),
    hasCashOrder: false,
    cashAmount: null,
    entryDate: reportDate("2025-01-10"),
    entryTimestamp: new Date("2025-01-10T08:09:10.987Z"),
  };
}

function snapshot(values: readonly string[]): ReportSnapshot {
  return {
    id: "snapshot-property-14",
    reportRequestId: "request-property-14",
    reportType: "weekly",
    period: { startDate: reportDate("2025-01-06"), endDate: reportDate("2025-01-12"), inclusive: true },
    createdAt: new Date("2025-01-13T00:00:00.000Z"),
    entries: values.map(entry),
    summary: { recordCount: 0, digitalIncomeTotal: zero(), cashIncomeTotal: zero(), halalIncomeTotal: zero(), nonHalalIncomeTotal: zero() },
  };
}

function parsedRestaurantNames(bytes: Uint8Array, count: number): string[] {
  const records = parse(new TextDecoder().decode(bytes), { relax_column_count: true }) as string[][];
  const headerIndex = records.findIndex((record) => record[0] === "Entry Date");
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  return records.slice(headerIndex + 1, headerIndex + 1 + count).map((record) => record[2]);
}

describe("CsvReportGenerator formula neutralization", () => {
  // Feature: bulk-csv-report-email, Property 14: Formula-trigger neutralization
  // **Validates: Requirements 5.5**
  it("adds exactly one apostrophe only to trigger-prefixed text before CSV encoding", () => {
    fc.assert(
      fc.property(
        fc.tuple(suffixArbitrary, suffixArbitrary, suffixArbitrary, suffixArbitrary),
        suffixArbitrary,
        fc.tuple(suffixArbitrary, suffixArbitrary, suffixArbitrary, suffixArbitrary),
        (triggerSuffixes, nonTriggerSuffix, apostropheSuffixes) => {
          const triggerValues = TRIGGERS.map(
            (trigger, index) => `${trigger}${CSV_SPECIAL_SUFFIXES[index]}${triggerSuffixes[index]}`,
          );
          const nonTriggerValues = NON_TRIGGER_PREFIXES.map(
            (prefix) => `${prefix}${nonTriggerSuffix}`,
          );
          const alreadyApostrophizedValues = TRIGGERS.map(
            (trigger, index) => `'${trigger}${apostropheSuffixes[index]}`,
          );
          const inputValues = [
            ...triggerValues,
            ...nonTriggerValues,
            ...alreadyApostrophizedValues,
          ];
          const attachment = new CsvReportGenerator(clock, telemetry).generate(snapshot(inputValues));
          const parsedValues = parsedRestaurantNames(attachment.bytes, inputValues.length);

          expect(parsedValues).toEqual([
            ...triggerValues.map((value) => `'${value}`),
            ...nonTriggerValues,
            ...alreadyApostrophizedValues,
          ]);
          triggerValues.forEach((value, index) => {
            expect(parsedValues[index][0]).toBe("'");
            expect(parsedValues[index].slice(1)).toBe(value);
          });
          alreadyApostrophizedValues.forEach((value, index) => {
            const parsed = parsedValues[triggerValues.length + nonTriggerValues.length + index];
            expect(parsed).toBe(value);
            expect(parsed.startsWith("''")).toBe(false);
          });
        },
      ),
      { numRuns: 150 },
    );
  });
});