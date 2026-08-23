import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportTelemetry } from "./observability";
import type { ReportDateString } from "./temporal";

const GENERATED_AT = new Date("2025-01-13T01:02:03.987Z");
const clock: Clock = { now: () => new Date(GENERATED_AT) };
const telemetry: ReportTelemetry = { emit: () => undefined };
const reportDate = (value: string) => value as ReportDateString;

interface MoneyCase {
  fareCents: number;
  hasCashOrder: boolean;
  storedCashCents: number;
}

const centsArbitrary = fc.integer({ min: 0, max: 999_999_999_999 });
const moneyCasesArbitrary = fc
  .record({
    generated: fc.array(
      fc.record({
        fareCents: centsArbitrary,
        hasCashOrder: fc.boolean(),
        storedCashCents: centsArbitrary,
      }),
      { minLength: 0, maxLength: 8 },
    ),
    zeroCashFareCents: centsArbitrary,
    falseFlagFareCents: centsArbitrary,
    ignoredStoredCashCents: fc.integer({ min: 1, max: 999_999_999_999 }),
  })
  .map(({ generated, zeroCashFareCents, falseFlagFareCents, ignoredStoredCashCents }) => [
    ...generated,
    {
      fareCents: zeroCashFareCents,
      hasCashOrder: true,
      storedCashCents: 0,
    },
    {
      fareCents: falseFlagFareCents,
      hasCashOrder: false,
      storedCashCents: ignoredStoredCashCents,
    },
  ] satisfies MoneyCase[]);

function formatCents(cents: number): string {
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  return `${whole}.${fraction.toString().padStart(2, "0")}`;
}

function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(formatCents(cents));
}

function toEntry(value: MoneyCase, index: number): ReportSnapshotEntry {
  return {
    sourceEntryId: `entry-${index.toString().padStart(2, "0")}`,
    restaurantName: `Restaurant ${index}`,
    restaurantStatus: index % 2 === 0 ? "halal" : "non-halal",
    fareAmount: decimalFromCents(value.fareCents),
    hasCashOrder: value.hasCashOrder,
    cashAmount: decimalFromCents(value.storedCashCents),
    entryDate: reportDate("2025-01-10"),
    entryTimestamp: new Date("2025-01-10T08:09:10.987Z"),
  };
}

function snapshot(entries: readonly ReportSnapshotEntry[]): ReportSnapshot {
  const zero = new Prisma.Decimal("0.00");
  return {
    id: "snapshot-property-9",
    reportRequestId: "request-property-9",
    reportType: "weekly",
    period: {
      startDate: reportDate("2025-01-06"),
      endDate: reportDate("2025-01-12"),
      inclusive: true,
    },
    createdAt: new Date("2025-01-13T00:00:00.000Z"),
    entries,
    summary: {
      recordCount: 0,
      digitalIncomeTotal: zero,
      cashIncomeTotal: zero,
      halalIncomeTotal: zero,
      nonHalalIncomeTotal: zero,
    },
  };
}

function detailRecords(csv: string, expectedCount: number): string[][] {
  const records = parse(csv, { relax_column_count: true }) as string[][];
  const headerIndex = records.findIndex((record) => record[0] === "Entry Date");
  expect(headerIndex).toBeGreaterThanOrEqual(0);
  return records.slice(headerIndex + 1, headerIndex + 1 + expectedCount);
}

describe("CsvReportGenerator entry money rendering", () => {
  // Feature: bulk-csv-report-email, Property 9: Entry money rendering and calculation
  // **Validates: Requirements 4.6, 4.7, 4.8, 4.9, 4.10**
  it("renders scale-two entry money and calculates cash inclusion from the flag", () => {
    fc.assert(
      fc.property(moneyCasesArbitrary, (moneyCases) => {
        const entries = moneyCases.map(toEntry);
        const attachment = new CsvReportGenerator(clock, telemetry).generate(
          snapshot(entries),
        );
        const records = detailRecords(
          new TextDecoder().decode(attachment.bytes),
          moneyCases.length,
        );

        expect(records).toHaveLength(moneyCases.length);
        records.forEach((record, index) => {
          const moneyCase = moneyCases[index];
          const expectedFare = formatCents(moneyCase.fareCents);
          const expectedCash = moneyCase.hasCashOrder
            ? formatCents(moneyCase.storedCashCents)
            : "";
          const expectedTotalCents =
            moneyCase.fareCents +
            (moneyCase.hasCashOrder ? moneyCase.storedCashCents : 0);
          const expectedTotal = formatCents(expectedTotalCents);

          expect(record[4]).toBe(expectedFare);
          expect(record[6]).toBe(expectedCash);
          expect(record[7]).toBe(expectedTotal);
          expect(record[4]).toMatch(/^\d+\.\d{2}$/);
          expect(record[7]).toMatch(/^\d+\.\d{2}$/);
          if (moneyCase.hasCashOrder) {
            expect(record[6]).toMatch(/^\d+\.\d{2}$/);
          }
          expect(record[4]).not.toMatch(/[,RM]/);
          expect(record[6]).not.toMatch(/[,RM]/);
          expect(record[7]).not.toMatch(/[,RM]/);
        });
      }),
      { numRuns: 150 },
    );
  });
});
