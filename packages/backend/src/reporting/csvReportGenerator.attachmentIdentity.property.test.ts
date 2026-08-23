import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { parse } from "csv-parse/sync";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { ReportSnapshot } from "./models";
import type { ReportDateString } from "./temporal";

const METADATA_KEYS = new Set([
  "Report Type", "Period Start", "Period End", "Generated At", "Currency",
]);
const DETAIL_KEYS = new Set([
  "Entry Date", "Delivery Entry Timestamp", "Restaurant Name", "Restaurant Status",
  "Fare Amount", "has_cash_order", "Cash Amount", "Entry Total",
]);
const SUMMARY_KEYS = new Set([
  "Delivery Record Count", "Digital Income Total", "Cash Income Total",
  "Halal Income Total", "Non-Halal Income Total",
]);
const zero = () => new Prisma.Decimal(0);
const dateString = (date: Date) => date.toISOString().slice(0, 10) as ReportDateString;
const utcDate = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month - 1, day));
const addDays = (date: Date, days: number) =>
  new Date(date.getTime() + days * 86_400_000);

function periods(year: number, month: number, day: number) {
  const reference = utcDate(year, month, day);
  const weeklyStart = addDays(reference, -((reference.getUTCDay() + 6) % 7));
  const monthlyStart = utcDate(year, month, 1);
  return [
    { reportType: "weekly" as const, start: weeklyStart, end: addDays(weeklyStart, 6) },
    { reportType: "monthly" as const, start: monthlyStart, end: utcDate(year, month + 1, 0) },
  ];
}

function snapshot(reportType: "weekly" | "monthly", start: Date, end: Date): ReportSnapshot {
  return {
    id: `property-15-${reportType}`,
    reportRequestId: `property-15-request-${reportType}`,
    reportType,
    period: { startDate: dateString(start), endDate: dateString(end), inclusive: true },
    createdAt: new Date("2025-01-01T00:00:00.000Z"),
    entries: [],
    summary: {
      recordCount: 0, digitalIncomeTotal: zero(), cashIncomeTotal: zero(),
      halalIncomeTotal: zero(), nonHalalIncomeTotal: zero(),
    },
  };
}

function expectAllowlistedKeys(actual: readonly string[], allowed: ReadonlySet<string>) {
  expect(actual).toHaveLength(allowed.size);
  expect(new Set(actual)).toEqual(allowed);
  expect(actual.every((key) => allowed.has(key))).toBe(true);
}

const seedArbitrary = fc.record({
  year: fc.integer({ min: 2000, max: 2099 }),
  month: fc.integer({ min: 1, max: 12 }),
  day: fc.integer({ min: 1, max: 28 }),
});
const generatedAt = new Date("2025-02-03T04:05:06.789Z");
const telemetry = { emit: () => undefined };

describe("CsvReportGenerator attachment identity and content closure", () => {
  // Feature: bulk-csv-report-email, Property 15: Attachment identity and content closure
  // **Validates: Requirements 5.6, 5.7, 5.8**
  it("closes weekly and monthly attachment identity and parsed content over the allowlist", () => {
    fc.assert(
      fc.property(seedArbitrary, ({ year, month, day }) => {
        for (const period of periods(year, month, day)) {
          const source = snapshot(period.reportType, period.start, period.end);
          const attachment = new CsvReportGenerator(
            { now: () => new Date(generatedAt) }, telemetry,
          ).generate(source);
          const csv = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
          const records = parse(csv, {
            relax_column_count: true,
            skip_empty_lines: false,
          }) as string[][];

          expect(attachment.filename).toBe(
            `${period.reportType}_${source.period.startDate}_${source.period.endDate}.csv`,
          );
          expect(attachment.mediaType).toBe("text/csv; charset=UTF-8");
          expect(attachment.byteSize).toBe(attachment.bytes.byteLength);
          expect(attachment.byteSize).toBe(Buffer.byteLength(csv, "utf8"));
          expect(attachment.sha256).toBe(
            createHash("sha256").update(attachment.bytes).digest("hex"),
          );
          expect([...new TextEncoder().encode(csv)]).toEqual([...attachment.bytes]);

          expect(records).toHaveLength(13);
          expect(records.slice(0, 5).every((row) => row.length === 2)).toBe(true);
          expect(records[5]).toEqual([""]);
          expect(records[6]).toHaveLength(DETAIL_KEYS.size);
          expect(records[7]).toEqual([""]);
          expect(records.slice(8).every((row) => row.length === 2)).toBe(true);
          expectAllowlistedKeys(records.slice(0, 5).map(([key]) => key), METADATA_KEYS);
          expectAllowlistedKeys(records[6], DETAIL_KEYS);
          expectAllowlistedKeys(records.slice(8).map(([key]) => key), SUMMARY_KEYS);
          expect(records[3][1]).toBe("2025-02-03T04:05:06Z");
          expect(attachment.generatedAt.toISOString()).toBe("2025-02-03T04:05:06.000Z");
        }
      }),
      { numRuns: 150 },
    );
  });
});