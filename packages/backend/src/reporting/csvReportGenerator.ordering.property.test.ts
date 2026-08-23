import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportTelemetry } from "./observability";
import type { ReportDateString } from "./temporal";

const reportDate = (value: string) => value as ReportDateString;
const zero = () => new Prisma.Decimal(0);
const clock: Clock = { now: () => new Date("2025-02-01T00:00:00.999Z") };
const telemetry: ReportTelemetry = { emit: () => undefined };

interface GeneratedEntry {
  readonly sourceEntryId: string;
  readonly day: number;
  readonly second: number;
  readonly millisecond: number;
}

const generatedExtras = fc.array(fc.record({
  day: fc.integer({ min: 1, max: 28 }),
  second: fc.integer({ min: 0, max: 86_399 }),
  millisecond: fc.integer({ min: 0, max: 999 }),
}), { minLength: 0, maxLength: 20 });

const generatedCase = fc.record({
  extras: generatedExtras,
  firstPermutationSeed: fc.integer(),
  secondPermutationSeed: fc.integer(),
});
function generatedEntries(extras: readonly Omit<GeneratedEntry, "sourceEntryId">[]): GeneratedEntry[] {
  return [
    { sourceEntryId: "tie-a", day: 15, second: 43_200, millisecond: 500 },
    { sourceEntryId: "tie-z", day: 15, second: 43_200, millisecond: 500 },
    { sourceEntryId: "same-date-newer-time", day: 15, second: 64_800, millisecond: 0 },
    { sourceEntryId: "older-date", day: 14, second: 86_399, millisecond: 999 },
    { sourceEntryId: "newer-date", day: 16, second: 0, millisecond: 0 },
    ...extras.map((entry, index) => ({
      sourceEntryId: `extra-${index.toString().padStart(2, "0")}`,
      ...entry,
    })),
  ];
}

function toSnapshotEntry(entry: GeneratedEntry): ReportSnapshotEntry {
  const date = `2025-01-${entry.day.toString().padStart(2, "0")}`;
  const timestamp = Date.UTC(2025, 0, entry.day)
    + entry.second * 1_000
    + entry.millisecond;
  return {
    sourceEntryId: entry.sourceEntryId,
    restaurantName: entry.sourceEntryId,
    restaurantStatus: "halal",
    fareAmount: new Prisma.Decimal("1.00"),
    hasCashOrder: false,
    cashAmount: null,
    entryDate: reportDate(date),
    entryTimestamp: new Date(timestamp),
  };
}

function snapshot(entries: readonly ReportSnapshotEntry[]): ReportSnapshot {
  return {
    id: "snapshot-property-8",
    reportRequestId: "request-property-8",
    reportType: "monthly",
    period: {
      startDate: reportDate("2025-01-01"),
      endDate: reportDate("2025-01-31"),
      inclusive: true,
    },
    createdAt: new Date("2025-02-01T00:00:00.000Z"),
    entries,
    summary: {
      recordCount: 0,
      digitalIncomeTotal: zero(),
      cashIncomeTotal: zero(),
      halalIncomeTotal: zero(),
      nonHalalIncomeTotal: zero(),
    },
  };
}
function permute<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function independentOrder(entries: readonly ReportSnapshotEntry[]): ReportSnapshotEntry[] {
  return [...entries].sort((left, right) => {
    const dateOrder = right.entryDate.localeCompare(left.entryDate);
    if (dateOrder !== 0) return dateOrder;

    const timestampOrder = right.entryTimestamp.getTime() - left.entryTimestamp.getTime();
    if (timestampOrder !== 0) return timestampOrder;

    return left.sourceEntryId.localeCompare(right.sourceEntryId, "en");
  });
}

function detailIds(bytes: Uint8Array, entryCount: number): string[] {
  const records = parse(new TextDecoder().decode(bytes), {
    bom: false,
    // Canonical metadata, separator, detail, and summary rows intentionally
    // have different widths; detail alignment is asserted explicitly below.
    relax_column_count: true,
    skip_empty_lines: false,
  }) as string[][];
  const headerIndex = records.findIndex((record) => record[0] === "Entry Date");
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  const details = records.slice(headerIndex + 1, headerIndex + 1 + entryCount);
  expect(details).toHaveLength(entryCount);
  expect(details.every((record) => record.length === 8)).toBe(true);
  return details.map((record) => record[2]);
}

describe("CsvReportGenerator deterministic detail ordering", () => {
  // Feature: bulk-csv-report-email, Property 8: Detail ordering is deterministic
  // **Validates: Requirements 4.4, 4.5**
  it("matches an independent ordering model for every generated input permutation", () => {
    fc.assert(fc.property(generatedCase, (input) => {
      const entries = generatedEntries(input.extras).map(toSnapshotEntry);
      const expected = independentOrder(entries);
      const firstInput = permute(entries, input.firstPermutationSeed);
      const secondInput = permute(entries, input.secondPermutationSeed);
      const generator = new CsvReportGenerator(clock, telemetry);

      const first = generator.generate(snapshot(firstInput));
      const second = generator.generate(snapshot(secondInput));
      const expectedIds = expected.map((entry) => entry.sourceEntryId);

      expect(detailIds(first.bytes, entries.length)).toEqual(expectedIds);
      expect(detailIds(second.bytes, entries.length)).toEqual(expectedIds);
      expect(Array.from(first.bytes)).toEqual(Array.from(second.bytes));
      expect(expectedIds.indexOf("newer-date"))
        .toBeLessThan(expectedIds.indexOf("same-date-newer-time"));
      expect(expectedIds.indexOf("same-date-newer-time"))
        .toBeLessThan(expectedIds.indexOf("tie-a"));
      expect(expectedIds.indexOf("tie-a"))
        .toBeLessThan(expectedIds.indexOf("tie-z"));
      expect(expectedIds.indexOf("tie-z"))
        .toBeLessThan(expectedIds.indexOf("older-date"));
    }), { numRuns: 150 });
  });
});
