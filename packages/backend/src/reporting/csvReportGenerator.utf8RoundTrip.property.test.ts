import { Prisma } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry, ReportSummary } from "./models";
import type { ReportDateString } from "./temporal";

interface GeneratedCase {
  readonly reportType: "weekly" | "monthly";
  readonly restaurantName: string;
  readonly restaurantStatus: "halal" | "non-halal";
  readonly fareCents: number;
  readonly hasCashOrder: boolean;
  readonly cashCents: number;
  readonly generatedAtMilliseconds: number;
}

interface ParsedCsv {
  readonly records: readonly string[][];
  readonly recordTerminators: number;
}

const unicodeScalarArbitrary = fc
  .oneof(
    fc.integer({ min: 0, max: 0xd7ff }),
    fc.integer({ min: 0xe000, max: 0x10ffff }),
  )
  .map((codePoint) => String.fromCodePoint(codePoint));

const unicodeSegmentArbitrary = fc
  .array(unicodeScalarArbitrary, { minLength: 0, maxLength: 8 })
  .map((characters) => characters.join(""));

const requiredCsvCharacters = [",", '"', "\r", "\n", "\u0000", "\u001f"] as const;

const restaurantNameArbitrary = fc
  .tuple(
    fc.array(unicodeSegmentArbitrary, { minLength: 7, maxLength: 7 }),
    fc.shuffledSubarray(requiredCsvCharacters, { minLength: 6, maxLength: 6 }),
  )
  .map(([segments, separators]) =>
    segments.map((segment, index) => segment + (separators[index] ?? "")).join(""),
  );
const generatedCaseArbitrary: fc.Arbitrary<GeneratedCase> = fc.record({
  reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
  restaurantName: restaurantNameArbitrary,
  restaurantStatus: fc.constantFrom<"halal" | "non-halal">("halal", "non-halal"),
  fareCents: fc.integer({ min: 0, max: 10_000_000 }),
  hasCashOrder: fc.boolean(),
  cashCents: fc.integer({ min: 0, max: 10_000_000 }),
  generatedAtMilliseconds: fc.integer({ min: 0, max: 999 }),
});

function reportDate(value: string): ReportDateString {
  return value as ReportDateString;
}

function money(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function summaryFor(entry: ReportSnapshotEntry): ReportSummary {
  const zero = new Prisma.Decimal(0);
  const cash = entry.hasCashOrder ? entry.cashAmount ?? zero : zero;
  const total = entry.fareAmount.plus(cash);
  return {
    recordCount: 1,
    digitalIncomeTotal: entry.fareAmount,
    cashIncomeTotal: cash,
    halalIncomeTotal: entry.restaurantStatus === "halal" ? total : zero,
    nonHalalIncomeTotal: entry.restaurantStatus === "non-halal" ? total : zero,
  };
}

function makeSnapshot(input: GeneratedCase): ReportSnapshot {
  const entry: ReportSnapshotEntry = {
    sourceEntryId: "property-13-entry",
    restaurantName: input.restaurantName,
    restaurantStatus: input.restaurantStatus,
    fareAmount: money(input.fareCents),
    hasCashOrder: input.hasCashOrder,
    cashAmount: money(input.cashCents),
    entryDate: reportDate("2025-01-10"),
    entryTimestamp: new Date("2025-01-10T08:09:10.987Z"),
  };
  return {
    id: "property-13-snapshot",
    reportRequestId: "property-13-request",
    reportType: input.reportType,
    period: {
      startDate: reportDate("2025-01-06"),
      endDate: reportDate("2025-01-12"),
      inclusive: true,
    },
    createdAt: new Date("2025-01-13T00:00:00.000Z"),
    entries: [entry],
    summary: summaryFor(entry),
  };
}

function parseCsvStrict(text: string): ParsedCsv {
  const records: string[][] = [];
  let record: string[] = [];
  let index = 0;
  let recordTerminators = 0;

  while (index < text.length) {
    let field = "";
    if (text[index] === '"') {
      index += 1;
      let closed = false;
      while (index < text.length) {
        if (text[index] !== '"') {
          field += text[index];
          index += 1;
        } else if (text[index + 1] === '"') {
          field += '"';
          index += 2;
        } else {
          index += 1;
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("Unclosed quoted CSV field");
    } else {
      while (index < text.length && text[index] !== "," && text[index] !== "\r" && text[index] !== "\n") {
        if (text[index] === '"') throw new Error("Quote in unquoted CSV field");
        field += text[index];
        index += 1;
      }
    }

    record.push(field);
    if (text[index] === ",") {
      index += 1;
      continue;
    }
    if (text[index] !== "\r" || text[index + 1] !== "\n") {
      throw new Error("Every CSV record must end with CRLF");
    }
    records.push(record);
    record = [];
    recordTerminators += 1;
    index += 2;
  }

  if (record.length !== 0) throw new Error("CSV ended in a partial record");
  return { records, recordTerminators };
}
function utcSecond(value: Date): string {
  return new Date(Math.floor(value.getTime() / 1_000) * 1_000)
    .toISOString()
    .replace(".000Z", "Z");
}

function safetyTransform(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

function expectedRecords(snapshot: ReportSnapshot, generatedAt: Date): string[][] {
  const entry = snapshot.entries[0];
  const cash = entry.hasCashOrder ? entry.cashAmount! : new Prisma.Decimal(0);
  const total = entry.fareAmount.plus(cash);
  const zero = "0.00";
  return [
    ["Report Type", snapshot.reportType],
    ["Period Start", snapshot.period.startDate],
    ["Period End", snapshot.period.endDate],
    ["Generated At", utcSecond(generatedAt)],
    ["Currency", "MYR"],
    [""],
    ["Entry Date", "Delivery Entry Timestamp", "Restaurant Name", "Restaurant Status", "Fare Amount", "has_cash_order", "Cash Amount", "Entry Total"],
    [
      entry.entryDate,
      utcSecond(entry.entryTimestamp),
      safetyTransform(entry.restaurantName),
      entry.restaurantStatus,
      entry.fareAmount.toFixed(2),
      entry.hasCashOrder ? "true" : "false",
      entry.hasCashOrder ? cash.toFixed(2) : "",
      total.toFixed(2),
    ],
    [""],
    ["Delivery Record Count", "1"],
    ["Digital Income Total", entry.fareAmount.toFixed(2)],
    ["Cash Income Total", entry.hasCashOrder ? cash.toFixed(2) : zero],
    ["Halal Income Total", entry.restaurantStatus === "halal" ? total.toFixed(2) : zero],
    ["Non-Halal Income Total", entry.restaurantStatus === "non-halal" ? total.toFixed(2) : zero],
  ];
}

const telemetry = { emit: () => undefined };

describe("CsvReportGenerator UTF-8 CSV round trips", () => {
  // Feature: bulk-csv-report-email, Property 13: UTF-8 CSV round trip
  // **Validates: Requirements 5.1, 5.2, 5.3, 5.4**
  it("strictly decodes and independently parses arbitrary Unicode values without loss", () => {
    fc.assert(
      fc.property(generatedCaseArbitrary, (input) => {
        const snapshot = makeSnapshot(input);
        const generatedAt = new Date(
          Date.parse("2025-01-13T01:02:03.000Z") + input.generatedAtMilliseconds,
        );
        const clock: Clock = { now: () => new Date(generatedAt) };
        const attachment = new CsvReportGenerator(clock, telemetry).generate(snapshot);
        const csv = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
        const parsed = parseCsvStrict(csv);
        const expected = expectedRecords(snapshot, generatedAt);

        expect(csv.endsWith("\r\n")).toBe(true);
        expect(parsed.recordTerminators).toBe(parsed.records.length);
        expect(parsed.records).toEqual(expected);
        expect(parsed.records[7][2]).toBe(safetyTransform(input.restaurantName));
      }),
      { numRuns: 150 },
    );
  });
});
