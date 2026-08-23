import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import {
  REPORT_CURRENCY,
  REPORT_CSV_MEDIA_TYPE,
} from "./constants";
import { ReportDomainError, isReportDomainError } from "./errors";
import type { Clock } from "./infrastructure";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";
import type {
  ReportAttachment,
  ReportSnapshot,
  ReportSnapshotEntry,
  ReportSummary,
} from "./models";
import { formatUtcTimestamp } from "./temporal";

type CsvCell = Readonly<{
  value: string;
  neutralizeFormula?: boolean;
}>;

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

/** Purely converts an immutable persisted snapshot into its canonical attachment. */
export class CsvReportGenerator {
  constructor(
    private readonly completionClock: Clock,
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {}

  generate(snapshot: ReportSnapshot): ReportAttachment {
    const startedAt = performance.now();
    try {
      const entries = orderEntries(snapshot.entries);
      const summary = summarize(entries);
      const generatedAt = truncateToUtcSecond(this.completionClock.now());
      const rows = buildRows(snapshot, entries, summary, generatedAt);
      const csv = `${rows.map(encodeRecord).join("\r\n")}\r\n`;
      assertWellFormedUnicode(csv);
      const bytes = new TextEncoder().encode(csv);

      const attachment: ReportAttachment = {
        reportRequestId: snapshot.reportRequestId,
        bytes,
        byteSize: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        filename: `${snapshot.reportType}_${snapshot.period.startDate}_${snapshot.period.endDate}.csv`,
        mediaType: REPORT_CSV_MEDIA_TYPE,
        generatedAt,
        summary,
      };
      this.telemetry.emit(REPORT_EVENTS.csvGenerated, {
        reportRequestId: snapshot.reportRequestId,
        stage: "csv_generation",
        durationMs: reportDurationMs(startedAt),
        recordCount: summary.recordCount,
        csvByteSize: attachment.byteSize,
      });
      return attachment;
    } catch (error) {
      if (isReportDomainError(error)) {
        throw error;
      }
      throw new ReportDomainError("csv_generation_failed", { cause: error });
    }
  }
}
function orderEntries(
  entries: readonly ReportSnapshotEntry[],
): ReportSnapshotEntry[] {
  return [...entries].sort((left, right) => {
    if (left.entryDate !== right.entryDate) {
      return left.entryDate > right.entryDate ? -1 : 1;
    }

    const leftTime = left.entryTimestamp.getTime();
    const rightTime = right.entryTimestamp.getTime();
    if (leftTime !== rightTime) {
      return leftTime > rightTime ? -1 : 1;
    }

    if (left.sourceEntryId === right.sourceEntryId) {
      return 0;
    }
    return left.sourceEntryId < right.sourceEntryId ? -1 : 1;
  });
}

function summarize(entries: readonly ReportSnapshotEntry[]): ReportSummary {
  let digitalIncomeTotal = decimalZero();
  let cashIncomeTotal = decimalZero();
  let halalIncomeTotal = decimalZero();
  let nonHalalIncomeTotal = decimalZero();

  for (const entry of entries) {
    const cash = includedCash(entry);
    const entryTotal = entry.fareAmount.plus(cash);
    digitalIncomeTotal = digitalIncomeTotal.plus(entry.fareAmount);
    cashIncomeTotal = cashIncomeTotal.plus(cash);

    if (entry.restaurantStatus === "halal") {
      halalIncomeTotal = halalIncomeTotal.plus(entryTotal);
    } else if (entry.restaurantStatus === "non-halal") {
      nonHalalIncomeTotal = nonHalalIncomeTotal.plus(entryTotal);
    }
  }

  return {
    recordCount: entries.length,
    digitalIncomeTotal,
    cashIncomeTotal,
    halalIncomeTotal,
    nonHalalIncomeTotal,
  };
}

function includedCash(entry: ReportSnapshotEntry): Prisma.Decimal {
  if (!entry.hasCashOrder) {
    return decimalZero();
  }
  if (entry.cashAmount === null) {
    throw new ReportDomainError("missing_required_cash_amount");
  }
  return entry.cashAmount;
}

function decimalZero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}
function buildRows(
  snapshot: ReportSnapshot,
  entries: readonly ReportSnapshotEntry[],
  summary: ReportSummary,
  generatedAt: Date,
): CsvCell[][] {
  const rows: CsvCell[][] = [
    cells("Report Type", text(snapshot.reportType)),
    cells("Period Start", snapshot.period.startDate),
    cells("Period End", snapshot.period.endDate),
    cells("Generated At", formatUtcTimestamp(generatedAt)),
    cells("Currency", text(REPORT_CURRENCY)),
    [cell("")],
    DETAIL_HEADER.map(cell),
  ];

  for (const entry of entries) {
    const cash = includedCash(entry);
    rows.push([
      cell(entry.entryDate),
      cell(formatUtcTimestamp(entry.entryTimestamp)),
      text(entry.restaurantName),
      text(entry.restaurantStatus),
      cell(formatMoney(entry.fareAmount)),
      cell(entry.hasCashOrder ? "true" : "false"),
      cell(entry.hasCashOrder ? formatMoney(cash) : ""),
      cell(formatMoney(entry.fareAmount.plus(cash))),
    ]);
  }

  rows.push(
    [cell("")],
    cells("Delivery Record Count", String(summary.recordCount)),
    cells("Digital Income Total", formatMoney(summary.digitalIncomeTotal)),
    cells("Cash Income Total", formatMoney(summary.cashIncomeTotal)),
    cells("Halal Income Total", formatMoney(summary.halalIncomeTotal)),
    cells("Non-Halal Income Total", formatMoney(summary.nonHalalIncomeTotal)),
  );
  return rows;
}

function cells(label: string, value: string | CsvCell): CsvCell[] {
  return [cell(label), typeof value === "string" ? cell(value) : value];
}

function cell(value: string): CsvCell {
  return { value };
}

function text(value: string): CsvCell {
  return { value, neutralizeFormula: true };
}

function formatMoney(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

function encodeRecord(record: readonly CsvCell[]): string {
  return record.map(encodeCell).join(",");
}

function encodeCell(csvCell: CsvCell): string {
  const value = csvCell.neutralizeFormula
    ? neutralizeFormula(csvCell.value)
    : csvCell.value;
  const escaped = value.replace(/"/g, '""');
  return /[",\r\n]/.test(value) ? `"${escaped}"` : escaped;
}

function neutralizeFormula(value: string): string {
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}
function truncateToUtcSecond(value: Date): Date {
  const milliseconds = value.getTime();
  if (!Number.isFinite(milliseconds)) {
    throw new RangeError("A valid completion instant is required");
  }
  return new Date(Math.floor(milliseconds / 1_000) * 1_000);
}

/** TextEncoder replaces lone UTF-16 surrogates; fail instead of losing fidelity. */
function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const following = value.charCodeAt(index + 1);
      if (!(following >= 0xdc00 && following <= 0xdfff)) {
        throw new TypeError("CSV text contains an unpaired high surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("CSV text contains an unpaired low surrogate");
    }
  }
}
