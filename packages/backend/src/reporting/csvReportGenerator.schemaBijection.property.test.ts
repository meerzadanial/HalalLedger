import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type {
  ReportSnapshot,
  ReportSnapshotEntry,
  ReportSummary,
} from "./models";
import type { ReportDateString } from "./temporal";

const DETAIL_HEADER = [
  "Entry Date",
  "Delivery Entry Timestamp",
  "Restaurant Name",
  "Restaurant Status",
  "Fare Amount",
  "has_cash_order",
  "Cash Amount",
  "Entry Total",
] as const;

const METADATA_LABELS = [
  "Report Type",
  "Period Start",
  "Period End",
  "Generated At",
  "Currency",
] as const;

const SUMMARY_LABELS = [
  "Delivery Record Count",
  "Digital Income Total",
  "Cash Income Total",
  "Halal Income Total",
  "Non-Halal Income Total",
] as const;

const DAY_MS = 86_400_000;
const BASE_DATE_MS = Date.parse("2020-01-01T00:00:00.000Z");
interface GeneratedEntry {
  readonly restaurantName: string;
  readonly restaurantStatus: "halal" | "non-halal";
  readonly fareCents: number;
  readonly hasCashOrder: boolean;
  readonly cashCents: number;
  readonly storeFalseCash: boolean;
  readonly dayOffset: number;
  readonly timestampOffsetSeconds: number;
}

interface GeneratedCase {
  readonly reportType: "weekly" | "monthly";
  readonly generatedAt: Date;
  readonly entries: readonly GeneratedEntry[];
}

const restaurantNameArbitrary = fc
  .array(
    fc.constantFrom(
      ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 0123456789",
    ),
    { minLength: 1, maxLength: 20 },
  )
  .map((characters) => characters.join(""));

const generatedCaseArbitrary: fc.Arbitrary<GeneratedCase> = fc.record({
  reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
  generatedAtMilliseconds: fc.integer({ min: 0, max: 999 }),
  entries: fc.array(
    fc.record({
      restaurantName: restaurantNameArbitrary,
      restaurantStatus: fc.constantFrom<"halal" | "non-halal">(
        "halal",
        "non-halal",
      ),
      fareCents: fc.integer({ min: 0, max: 10_000_000 }),
      hasCashOrder: fc.boolean(),
      cashCents: fc.integer({ min: 0, max: 10_000_000 }),
      storeFalseCash: fc.boolean(),
      dayOffset: fc.integer({ min: 0, max: 30 }),
      timestampOffsetSeconds: fc.integer({ min: 0, max: 2_678_399 }),
    }),
    { minLength: 0, maxLength: 15 },
  ),
}).map(({ reportType, generatedAtMilliseconds, entries }) => ({
  reportType,
  generatedAt: new Date(
    Date.parse("2025-02-01T10:20:30.000Z") + generatedAtMilliseconds,
  ),
  entries,
}));

function reportDate(value: string): ReportDateString {
  return value as ReportDateString;
}

function dateAt(offset: number): ReportDateString {
  return reportDate(new Date(BASE_DATE_MS + offset * DAY_MS).toISOString().slice(0, 10));
}

function money(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}
function makeEntries(values: readonly GeneratedEntry[]): ReportSnapshotEntry[] {
  return values.map((value, index) => ({
    sourceEntryId: `source-${index}`,
    restaurantName: `Restaurant ${index} ${value.restaurantName}`,
    restaurantStatus: value.restaurantStatus,
    fareAmount: money(value.fareCents),
    hasCashOrder: value.hasCashOrder,
    cashAmount:
      value.hasCashOrder || value.storeFalseCash
        ? money(value.cashCents)
        : null,
    entryDate: dateAt(value.dayOffset),
    entryTimestamp: new Date(
      BASE_DATE_MS + value.timestampOffsetSeconds * 1_000 + 987,
    ),
  }));
}

function summarize(entries: readonly ReportSnapshotEntry[]): ReportSummary {
  let digital = new Prisma.Decimal(0);
  let cash = new Prisma.Decimal(0);
  let halal = new Prisma.Decimal(0);
  let nonHalal = new Prisma.Decimal(0);

  for (const entry of entries) {
    const includedCash = entry.hasCashOrder
      ? entry.cashAmount ?? new Prisma.Decimal(0)
      : new Prisma.Decimal(0);
    const total = entry.fareAmount.plus(includedCash);
    digital = digital.plus(entry.fareAmount);
    cash = cash.plus(includedCash);
    if (entry.restaurantStatus === "halal") {
      halal = halal.plus(total);
    } else {
      nonHalal = nonHalal.plus(total);
    }
  }

  return {
    recordCount: entries.length,
    digitalIncomeTotal: digital,
    cashIncomeTotal: cash,
    halalIncomeTotal: halal,
    nonHalalIncomeTotal: nonHalal,
  };
}

function makeSnapshot(input: GeneratedCase): ReportSnapshot {
  const entries = makeEntries(input.entries);
  return {
    id: "property-7-snapshot",
    reportRequestId: "property-7-request",
    reportType: input.reportType,
    period: {
      startDate: reportDate("2020-01-01"),
      endDate: reportDate("2020-01-31"),
      inclusive: true,
    },
    createdAt: new Date("2020-02-01T00:00:00.000Z"),
    entries,
    summary: summarize(entries),
  };
}

function utcSecond(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}
function expectedDetail(entry: ReportSnapshotEntry): string[] {
  const includedCash = entry.hasCashOrder
    ? entry.cashAmount ?? new Prisma.Decimal(0)
    : new Prisma.Decimal(0);
  return [
    entry.entryDate,
    utcSecond(entry.entryTimestamp),
    entry.restaurantName,
    entry.restaurantStatus,
    entry.fareAmount.toFixed(2),
    entry.hasCashOrder ? "true" : "false",
    entry.hasCashOrder ? includedCash.toFixed(2) : "",
    entry.fareAmount.plus(includedCash).toFixed(2),
  ];
}

function countRows(rows: readonly string[][]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const signature = JSON.stringify(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return counts;
}

function recordsWithLabel(
  records: readonly string[][],
  label: string,
): string[][] {
  return records.filter((record) => record[0] === label);
}

const telemetry = { emit: () => undefined };

describe("CsvReportGenerator schema and detail bijection", () => {
  // Feature: bulk-csv-report-email, Property 7: CSV report schema and detail bijection
  // **Validates: Requirements 4.1, 4.2, 4.3, 4.11**
  it("emits one complete schema row and one aligned detail per snapshot entry", () => {
    fc.assert(
      fc.property(generatedCaseArbitrary, (input) => {
        const snapshot = makeSnapshot(input);
        const clock: Clock = { now: () => new Date(input.generatedAt) };
        const attachment = new CsvReportGenerator(clock, telemetry).generate(
          snapshot,
        );
        const csv = new TextDecoder("utf-8", { fatal: true }).decode(
          attachment.bytes,
        );
        const records = parse(csv, {
          relax_column_count: true,
          skip_empty_lines: false,
        }) as string[][];

        expect(records).toHaveLength(snapshot.entries.length + 13);
        expect(records[5]).toEqual([""]);
        expect(records[6]).toEqual(DETAIL_HEADER);
        expect(records[7 + snapshot.entries.length]).toEqual([""]);

        const expectedMetadata = [
          ["Report Type", snapshot.reportType],
          ["Period Start", snapshot.period.startDate],
          ["Period End", snapshot.period.endDate],
          ["Generated At", utcSecond(input.generatedAt)],
          ["Currency", "MYR"],
        ];
        expect(records.slice(0, 5)).toEqual(expectedMetadata);
        for (const label of METADATA_LABELS) {
          const matches = recordsWithLabel(records, label);
          expect(matches).toHaveLength(1);
          expect(matches[0]).toHaveLength(2);
        }

        expect(new Set(records[6])).toEqual(new Set(DETAIL_HEADER));
        expect(records[6]).toHaveLength(DETAIL_HEADER.length);
        for (const heading of DETAIL_HEADER) {
          expect(records[6].filter((value) => value === heading)).toHaveLength(1);
        }
        const detailRows = records.slice(7, 7 + snapshot.entries.length);
        expect(detailRows).toHaveLength(snapshot.entries.length);
        for (const row of detailRows) {
          expect(row).toHaveLength(DETAIL_HEADER.length);
          expect(row[5] === "true" || row[5] === "false").toBe(true);
        }

        const expectedRows = snapshot.entries.map(expectedDetail);
        const expectedCounts = countRows(expectedRows);
        const actualCounts = countRows(detailRows);
        expect(expectedCounts.size).toBe(snapshot.entries.length);
        expect(actualCounts).toEqual(expectedCounts);
        for (const expectedRow of expectedRows) {
          expect(actualCounts.get(JSON.stringify(expectedRow))).toBe(1);
        }

        const summaryRows = records.slice(8 + snapshot.entries.length);
        expect(summaryRows).toHaveLength(SUMMARY_LABELS.length);
        for (const label of SUMMARY_LABELS) {
          const matches = recordsWithLabel(records, label);
          expect(matches).toHaveLength(1);
          expect(matches[0]).toHaveLength(2);
        }
        expect(summaryRows.map(([label]) => label)).toEqual(SUMMARY_LABELS);
      }),
      { numRuns: 150 },
    );
  });
});
