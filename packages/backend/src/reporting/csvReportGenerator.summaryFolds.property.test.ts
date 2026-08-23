import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportDateString } from "./temporal";

const SUMMARY_LABELS = [
  "Delivery Record Count",
  "Digital Income Total",
  "Cash Income Total",
  "Halal Income Total",
  "Non-Halal Income Total",
] as const;

const clock: Clock = {
  now: () => new Date("2025-01-13T01:02:03.987Z"),
};

interface GeneratedEntry {
  readonly fareCents: number;
  readonly hasCashOrder: boolean;
  readonly cashCents: number;
  readonly storeFalseCash: boolean;
  readonly restaurantStatus: "halal" | "non-halal";
}

const generatedEntry = fc.record({
  fareCents: fc.integer({ min: 0, max: 99_999_999 }),
  hasCashOrder: fc.boolean(),
  cashCents: fc.integer({ min: 0, max: 99_999_999 }),
  storeFalseCash: fc.boolean(),
  restaurantStatus: fc.constantFrom<"halal" | "non-halal">(
    "halal",
    "non-halal",
  ),
});

const snapshotsIncludingEmpty = fc.tuple(
  fc.constant<GeneratedEntry[]>([]),
  fc.array(generatedEntry, { minLength: 0, maxLength: 30 }),
);

function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function reportDate(value: string): ReportDateString {
  return value as ReportDateString;
}

function toSnapshot(
  generatedEntries: readonly GeneratedEntry[],
): ReportSnapshot {
  const entries: ReportSnapshotEntry[] = generatedEntries.map((entry, index) => ({
    sourceEntryId: `entry-${index}`,
    restaurantName: `Restaurant ${index}`,
    restaurantStatus: entry.restaurantStatus,
    fareAmount: decimalFromCents(entry.fareCents),
    hasCashOrder: entry.hasCashOrder,
    cashAmount:
      entry.hasCashOrder || entry.storeFalseCash
        ? decimalFromCents(entry.cashCents)
        : null,
    entryDate: reportDate(`2025-01-${String(6 + (index % 7)).padStart(2, "0")}`),
    entryTimestamp: new Date(
      Date.UTC(2025, 0, 6 + (index % 7), 0, 0, index),
    ),
  }));

  const deliberatelyIncorrect = new Prisma.Decimal("999999999999.99");
  return {
    id: "snapshot-property-10",
    reportRequestId: "request-property-10",
    reportType: "weekly",
    period: {
      startDate: reportDate("2025-01-06"),
      endDate: reportDate("2025-01-12"),
      inclusive: true,
    },
    createdAt: new Date("2025-01-13T00:00:00.000Z"),
    entries,
    summary: {
      recordCount: -1,
      digitalIncomeTotal: deliberatelyIncorrect,
      cashIncomeTotal: deliberatelyIncorrect,
      halalIncomeTotal: deliberatelyIncorrect,
      nonHalalIncomeTotal: deliberatelyIncorrect,
    },
  };
}

function independentFold(entries: readonly ReportSnapshotEntry[]) {
  let digitalIncomeTotal = new Prisma.Decimal(0);
  let cashIncomeTotal = new Prisma.Decimal(0);
  let halalIncomeTotal = new Prisma.Decimal(0);
  let nonHalalIncomeTotal = new Prisma.Decimal(0);

  for (const entry of entries) {
    const includedCash = entry.hasCashOrder
      ? new Prisma.Decimal(entry.cashAmount!)
      : new Prisma.Decimal(0);
    const entryTotal = new Prisma.Decimal(entry.fareAmount).plus(includedCash);
    digitalIncomeTotal = digitalIncomeTotal.plus(entry.fareAmount);
    cashIncomeTotal = cashIncomeTotal.plus(includedCash);

    if (entry.restaurantStatus === "halal") {
      halalIncomeTotal = halalIncomeTotal.plus(entryTotal);
    } else {
      nonHalalIncomeTotal = nonHalalIncomeTotal.plus(entryTotal);
    }
  }

  return {
    recordCount: entries.length,
    digitalIncomeTotal: digitalIncomeTotal.toFixed(2),
    cashIncomeTotal: cashIncomeTotal.toFixed(2),
    halalIncomeTotal: halalIncomeTotal.toFixed(2),
    nonHalalIncomeTotal: nonHalalIncomeTotal.toFixed(2),
  };
}

function parsedSummary(bytes: Uint8Array): Map<string, string> {
  const records = parse(new TextDecoder().decode(bytes), {
    relax_column_count: true,
  }) as string[][];
  const result = new Map<string, string>();

  for (const label of SUMMARY_LABELS) {
    const matchingRows = records.filter((row) => row[0] === label);
    expect(matchingRows).toHaveLength(1);
    result.set(label, matchingRows[0][1]);
  }

  return result;
}

function detailRecordCount(bytes: Uint8Array): number {
  const records = parse(new TextDecoder().decode(bytes), {
    relax_column_count: true,
  }) as string[][];
  const headerIndex = records.findIndex((row) => row[0] === "Entry Date");
  const summaryIndex = records.findIndex(
    (row) => row[0] === "Delivery Record Count",
  );
  return records
    .slice(headerIndex + 1, summaryIndex)
    .filter((row) => row.some((value) => value !== "")).length;
}

describe("CsvReportGenerator summary folds", () => {
  // Feature: bulk-csv-report-email, Property 10: Summary values equal exact snapshot folds
  // **Validates: Requirements 4.11, 4.12, 4.13, 4.14, 4.15, 4.16**
  it("emits every summary from independent exact Decimal folds, including empty snapshots", () => {
    fc.assert(
      fc.property(snapshotsIncludingEmpty, ([emptyEntries, generatedEntries]) => {
        for (const values of [emptyEntries, generatedEntries]) {
          const snapshot = toSnapshot(values);
          const expected = independentFold(snapshot.entries);
          const attachment = new CsvReportGenerator(clock).generate(snapshot);
          const csvSummary = parsedSummary(attachment.bytes);

          expect(attachment.summary.recordCount).toBe(expected.recordCount);
          expect(attachment.summary.digitalIncomeTotal.toFixed(2)).toBe(
            expected.digitalIncomeTotal,
          );
          expect(attachment.summary.cashIncomeTotal.toFixed(2)).toBe(
            expected.cashIncomeTotal,
          );
          expect(attachment.summary.halalIncomeTotal.toFixed(2)).toBe(
            expected.halalIncomeTotal,
          );
          expect(attachment.summary.nonHalalIncomeTotal.toFixed(2)).toBe(
            expected.nonHalalIncomeTotal,
          );
          expect(csvSummary).toEqual(
            new Map([
              ["Delivery Record Count", String(expected.recordCount)],
              ["Digital Income Total", expected.digitalIncomeTotal],
              ["Cash Income Total", expected.cashIncomeTotal],
              ["Halal Income Total", expected.halalIncomeTotal],
              ["Non-Halal Income Total", expected.nonHalalIncomeTotal],
            ]),
          );
          expect(detailRecordCount(attachment.bytes)).toBe(snapshot.entries.length);
        }
      }),
      { numRuns: 150 },
    );
  });
});
