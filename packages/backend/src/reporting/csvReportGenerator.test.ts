import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportDateString } from "./temporal";

const GENERATED_AT = "2025-01-13T01:02:03.987Z";
const reportDate = (value: string) => value as ReportDateString;
const decimal = (value: string) => new Prisma.Decimal(value);

function entry(
  overrides: Partial<ReportSnapshotEntry> = {},
): ReportSnapshotEntry {
  return {
    sourceEntryId: "entry-1",
    restaurantName: "Restaurant",
    restaurantStatus: "halal",
    fareAmount: decimal("10.00"),
    hasCashOrder: false,
    cashAmount: null,
    entryDate: reportDate("2025-01-10"),
    entryTimestamp: new Date("2025-01-10T08:09:10.987Z"),
    ...overrides,
  };
}

function snapshot(entries: readonly ReportSnapshotEntry[]): ReportSnapshot {
  return {
    id: "snapshot-1",
    reportRequestId: "request-1",
    reportType: "weekly",
    period: {
      startDate: reportDate("2025-01-06"),
      endDate: reportDate("2025-01-12"),
      inclusive: true,
    },
    createdAt: new Date("2025-01-13T00:00:00.000Z"),
    entries,
    summary: {
      recordCount: entries.length,
      digitalIncomeTotal: decimal("0.00"),
      cashIncomeTotal: decimal("0.00"),
      halalIncomeTotal: decimal("0.00"),
      nonHalalIncomeTotal: decimal("0.00"),
    },
  };
}

function clock(value = GENERATED_AT): Clock {
  return { now: () => new Date(value) };
}

function generate(
  entries: readonly ReportSnapshotEntry[],
  generatedAt = GENERATED_AT,
) {
  return new CsvReportGenerator(clock(generatedAt), {
    emit: () => undefined,
  }).generate(snapshot(entries));
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

const CANONICAL_CSV = [
  "Report Type,weekly",
  "Period Start,2025-01-06",
  "Period End,2025-01-12",
  "Generated At,2025-01-13T01:02:03Z",
  "Currency,MYR",
  "",
  "Entry Date,Delivery Entry Timestamp,Restaurant Name,Restaurant Status,Fare Amount,has_cash_order,Cash Amount,Entry Total",
  "2025-01-12,2025-01-12T11:12:13Z,Sinar Café,halal,10.00,true,5.00,15.00",
  "2025-01-11,2025-01-11T09:10:11Z,Kedai Makan,halal,10.00,false,,10.00",
  "2025-01-10,2025-01-10T08:09:10Z,Bistro,non-halal,10.00,false,,10.00",
  "",
  "Delivery Record Count,3",
  "Digital Income Total,30.00",
  "Cash Income Total,5.00",
  "Halal Income Total,25.00",
  "Non-Halal Income Total,10.00",
].join("\r\n") + "\r\n";

describe("CsvReportGenerator focused examples", () => {
  it("matches the canonical design report and its golden attachment identity", () => {
    const input = snapshot([
      entry({
        sourceEntryId: "entry-3",
        restaurantName: "Sinar Café",
        fareAmount: decimal("10.00"),
        hasCashOrder: true,
        cashAmount: decimal("5.00"),
        entryDate: reportDate("2025-01-12"),
        entryTimestamp: new Date("2025-01-12T11:12:13.999Z"),
      }),
      entry({
        sourceEntryId: "entry-2",
        restaurantName: "Kedai Makan",
        fareAmount: decimal("10.00"),
        cashAmount: null,
        entryDate: reportDate("2025-01-11"),
        entryTimestamp: new Date("2025-01-11T09:10:11.555Z"),
      }),
      entry({
        sourceEntryId: "entry-1",
        restaurantName: "Bistro",
        restaurantStatus: "non-halal",
        fareAmount: decimal("10.00"),
        cashAmount: decimal("99.99"),
      }),
    ]);
    const before = JSON.stringify(input);
    const generator = new CsvReportGenerator(clock(), {
      emit: () => undefined,
    });

    const first = generator.generate(input);
    const second = generator.generate(input);

    expect(decode(first.bytes)).toBe(CANONICAL_CSV);
    expect(first).toMatchObject({
      reportRequestId: "request-1",
      byteSize: 588,
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: "text/csv; charset=UTF-8",
      generatedAt: new Date("2025-01-13T01:02:03.000Z"),
      sha256: "0c13ed32a5e42551d7bb04173a6db4f728bf811156478dbebf2deef79aceec85",
    });
    expect(first.byteSize).toBe(CANONICAL_CSV.length + 1);
    expect(first.summary.recordCount).toBe(3);
    expect(first.summary.digitalIncomeTotal.toFixed(2)).toBe("30.00");
    expect(first.summary.cashIncomeTotal.toFixed(2)).toBe("5.00");
    expect(first.summary.halalIncomeTotal.toFixed(2)).toBe("25.00");
    expect(first.summary.nonHalalIncomeTotal.toFixed(2)).toBe("10.00");
    expect(second.sha256).toBe(first.sha256);
    expect(Array.from(second.bytes)).toEqual(Array.from(first.bytes));
    expect(CANONICAL_CSV.endsWith("\r\n")).toBe(true);
    expect(CANONICAL_CSV.endsWith("\r\n\r\n")).toBe(false);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("matches the empty-report golden including exact zero summaries", () => {
    const expected = [
      "Report Type,weekly",
      "Period Start,2025-01-06",
      "Period End,2025-01-12",
      "Generated At,2025-01-13T01:02:03Z",
      "Currency,MYR",
      "",
      "Entry Date,Delivery Entry Timestamp,Restaurant Name,Restaurant Status,Fare Amount,has_cash_order,Cash Amount,Entry Total",
      "",
      "Delivery Record Count,0",
      "Digital Income Total,0.00",
      "Cash Income Total,0.00",
      "Halal Income Total,0.00",
      "Non-Halal Income Total,0.00",
    ].join("\r\n") + "\r\n";

    expect(decode(generate([]).bytes)).toBe(expected);
  });

  it("distinguishes true zero cash from false null cash", () => {
    const csv = decode(generate([
      entry({
        sourceEntryId: "zero-cash",
        restaurantName: "Zero Cash",
        hasCashOrder: true,
        cashAmount: decimal("0.00"),
        entryDate: reportDate("2025-01-12"),
      }),
      entry({
        sourceEntryId: "null-cash",
        restaurantName: "No Cash Order",
        hasCashOrder: false,
        cashAmount: null,
        entryDate: reportDate("2025-01-11"),
      }),
    ]).bytes);

    expect(csv).toContain(
      "Zero Cash,halal,10.00,true,0.00,10.00\r\n",
    );
    expect(csv).toContain(
      "No Cash Order,halal,10.00,false,,10.00\r\n",
    );
  });

  it("truncates entry and completion timestamps to UTC seconds", () => {
    const result = generate([
      entry({
        entryTimestamp: new Date("2025-01-10T08:09:10.999Z"),
      }),
    ]);
    const csv = decode(result.bytes);

    expect(csv).toContain("Generated At,2025-01-13T01:02:03Z\r\n");
    expect(csv).toContain("2025-01-10T08:09:10Z,Restaurant");
    expect(csv).not.toContain(".987Z");
    expect(csv).not.toContain(".999Z");
    expect(result.generatedAt).toEqual(new Date("2025-01-13T01:02:03.000Z"));
  });

  it.each([
    { source: "=SUM(A1:A2)", encoded: "'=SUM(A1:A2)" },
    { source: "+SUM(A1:A2)", encoded: "'+SUM(A1:A2)" },
    { source: "-SUM(A1:A2)", encoded: "'-SUM(A1:A2)" },
    { source: "@SUM(A1:A2)", encoded: "'@SUM(A1:A2)" },
    { source: "'=SUM(A1:A2)", encoded: "'=SUM(A1:A2)" },
    { source: " =SUM(A1:A2)", encoded: " =SUM(A1:A2)" },
  ])("neutralizes formula example $source exactly once", ({ source, encoded }) => {
    const csv = decode(generate([entry({ restaurantName: source })]).bytes);

    expect(csv).toContain(`,${encoded},halal,`);
  });

  it.each([
    { source: "Plain Cafe", encoded: "Plain Cafe" },
    { source: "Comma, Cafe", encoded: '"Comma, Cafe"' },
    { source: 'Quote "Cafe"', encoded: '"Quote ""Cafe"""' },
    { source: "Carriage\rReturn", encoded: '"Carriage\rReturn"' },
    { source: "Line\nFeed", encoded: '"Line\nFeed"' },
    { source: "Both\r\nBreak", encoded: '"Both\r\nBreak"' },
    { source: "=SUM(1,2)", encoded: '"\'=SUM(1,2)"' },
  ])("encodes CSV escape example $source", ({ source, encoded }) => {
    const csv = decode(generate([entry({ restaurantName: source })]).bytes);

    expect(csv).toContain(`,${encoded},halal,`);
  });

  it("fails with the typed missing-cash error without changing the snapshot", () => {
    const input = snapshot([
      entry({ hasCashOrder: true, cashAmount: null }),
    ]);
    const before = JSON.stringify(input);

    expect(() =>
      new CsvReportGenerator(clock(), { emit: () => undefined }).generate(input),
    ).toThrowError(
      expect.objectContaining({
        code: "missing_required_cash_amount",
        stage: "csv_generation",
      }),
    );
    expect(JSON.stringify(input)).toBe(before);
  });

  it("fails with a typed encoding error instead of replacing invalid Unicode", () => {
    const input = snapshot([entry({ restaurantName: "invalid-\ud800" })]);

    expect(() =>
      new CsvReportGenerator(clock(), { emit: () => undefined }).generate(input),
    ).toThrowError(
      expect.objectContaining({
        code: "csv_generation_failed",
        stage: "csv_generation",
      }),
    );
  });
});
