import {
  Prisma,
  PrismaClient,
  ReportType as DbReportType,
} from "@prisma/client";
import type { ReportType } from "./constants";
import { ReportDomainError, isReportDomainError } from "./errors";
import type {
  ReportSnapshot,
  ReportSnapshotEntry,
  ReportSummary,
  RestaurantStatus,
} from "./models";
import type { RecordReportFailureInput } from "./reportRequestService";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";
import type { ReportDateString } from "./temporal";

const SNAPSHOT_INCLUDE = {
  reportRequest: {
    select: { reportType: true, periodStart: true, periodEnd: true },
  },
  entries: {
    orderBy: [
      { entryDate: "desc" },
      { entryTimestamp: "desc" },
      { sourceEntryId: "asc" },
    ],
  },
} as const satisfies Prisma.ReportSnapshotInclude;

type SnapshotRow = Prisma.ReportSnapshotGetPayload<{
  include: typeof SNAPSHOT_INCLUDE;
}>;

type SnapshotFailureRecorder = {
  recordFailure(input: RecordReportFailureInput): Promise<unknown>;
};

export interface ReportSnapshotAccessInput {
  readonly reportRequestId: string;
  /** The authenticated account ID; never accept this value from report payloads. */
  readonly userId: string;
}

export interface CreateReportSnapshotOptions {
  /** Workers defer terminal recording so transient failures can use bounded job retries. */
  readonly recordFailure?: boolean;
}

export class ReportDataService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly failureRecorder: SnapshotFailureRecorder,
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {}

  async createSnapshot(
    input: ReportSnapshotAccessInput,
    options: CreateReportSnapshotOptions = {},
  ): Promise<ReportSnapshot> {
    let stage: "data_retrieval" | "snapshot" = "data_retrieval";
    const startedAt = performance.now();

    try {
      const snapshot = await this.prisma.$transaction(
        async (tx) => {
          const request = await tx.reportRequest.findFirst({
            where: { id: input.reportRequestId, userId: input.userId },
            select: {
              reportType: true,
              periodStart: true,
              periodEnd: true,
            },
          });
          if (request === null) {
            throw new ReportDomainError("report_not_found");
          }

          const existing = await tx.reportSnapshot.findUnique({
            where: { reportRequestId: input.reportRequestId },
            include: SNAPSHOT_INCLUDE,
          });
          if (existing !== null) {
            return toDomainSnapshot(existing);
          }

          const sourceRows = await tx.deliveryEntry.findMany({
            where: {
              userId: input.userId,
              entryDate: {
                gte: cloneDate(request.periodStart),
                lte: cloneDate(request.periodEnd),
              },
            },
            orderBy: [
              { entryDate: "desc" },
              { timestamp: "desc" },
              { id: "asc" },
            ],
            select: {
              id: true,
              restaurantName: true,
              restaurantStatus: true,
              fareAmount: true,
              hasCashOrder: true,
              cashAmount: true,
              entryDate: true,
              timestamp: true,
            },
          });

          stage = "snapshot";
          const copiedEntries = sourceRows.map(copySourceEntry);
          const summary = summarize(copiedEntries);
          const created = await tx.reportSnapshot.create({
            data: {
              reportRequestId: input.reportRequestId,
              recordCount: summary.recordCount,
              digitalIncomeTotal: summary.digitalIncomeTotal,
              cashIncomeTotal: summary.cashIncomeTotal,
              halalIncomeTotal: summary.halalIncomeTotal,
              nonHalalIncomeTotal: summary.nonHalalIncomeTotal,
              ...(copiedEntries.length === 0
                ? {}
                : {
                    entries: {
                      create: copiedEntries.map(toSnapshotEntryCreate),
                    },
                  }),
            },
            include: SNAPSHOT_INCLUDE,
          });
          return toDomainSnapshot(created);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      this.telemetry.emit(REPORT_EVENTS.snapshotCommitted, {
        reportRequestId: input.reportRequestId,
        userId: input.userId,
        stage: "snapshot",
        durationMs: reportDurationMs(startedAt),
        recordCount: snapshot.summary.recordCount,
      });
      return snapshot;
    } catch (error) {
      if (isReportDomainError(error) && error.code === "report_not_found") {
        throw error;
      }

      const failure = new ReportDomainError(
        stage === "data_retrieval"
          ? "data_retrieval_failed"
          : "snapshot_failed",
        { cause: error },
      );
      if (options.recordFailure !== false) {
        try {
          // This deliberately runs after the snapshot transaction has rolled back.
          await this.failureRecorder.recordFailure({
            reportRequestId: input.reportRequestId,
            failure,
          });
        } catch (recordingError) {
          throw new ReportDomainError(failure.code, { cause: recordingError });
        }
      }
      throw failure;
    }
  }

  async readSnapshot(
    input: ReportSnapshotAccessInput,
  ): Promise<ReportSnapshot | null> {
    const row = await this.prisma.reportSnapshot.findFirst({
      where: {
        reportRequestId: input.reportRequestId,
        reportRequest: { is: { userId: input.userId } },
      },
      include: SNAPSHOT_INCLUDE,
    });
    return row === null ? null : toDomainSnapshot(row);
  }
}

function copySourceEntry(row: {
  id: string;
  restaurantName: string;
  restaurantStatus: string;
  fareAmount: Prisma.Decimal;
  hasCashOrder: boolean;
  cashAmount: Prisma.Decimal | null;
  entryDate: Date;
  timestamp: Date;
}): ReportSnapshotEntry {
  return {
    sourceEntryId: row.id,
    restaurantName: row.restaurantName,
    restaurantStatus: row.restaurantStatus as RestaurantStatus,
    fareAmount: cloneDecimal(row.fareAmount),
    hasCashOrder: row.hasCashOrder,
    cashAmount:
      row.cashAmount === null ? null : cloneDecimal(row.cashAmount),
    entryDate: toReportDate(row.entryDate),
    entryTimestamp: cloneDate(row.timestamp),
  };
}

function toSnapshotEntryCreate(entry: ReportSnapshotEntry) {
  return {
    sourceEntryId: entry.sourceEntryId,
    restaurantName: entry.restaurantName,
    restaurantStatus: entry.restaurantStatus,
    fareAmount: cloneDecimal(entry.fareAmount),
    hasCashOrder: entry.hasCashOrder,
    cashAmount:
      entry.cashAmount === null ? null : cloneDecimal(entry.cashAmount),
    entryDate: databaseDate(entry.entryDate),
    entryTimestamp: cloneDate(entry.entryTimestamp),
  };
}

function summarize(entries: readonly ReportSnapshotEntry[]): ReportSummary {
  let digitalIncomeTotal = zero();
  let cashIncomeTotal = zero();
  let halalIncomeTotal = zero();
  let nonHalalIncomeTotal = zero();

  for (const entry of entries) {
    digitalIncomeTotal = digitalIncomeTotal.plus(entry.fareAmount);
    const includedCash =
      entry.hasCashOrder && entry.cashAmount !== null
        ? entry.cashAmount
        : zero();
    cashIncomeTotal = cashIncomeTotal.plus(includedCash);
    const entryTotal = entry.fareAmount.plus(includedCash);
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

function toDomainSnapshot(row: SnapshotRow): ReportSnapshot {
  return {
    id: row.id,
    reportRequestId: row.reportRequestId,
    reportType: fromDbReportType(row.reportRequest.reportType),
    period: {
      startDate: toReportDate(row.reportRequest.periodStart),
      endDate: toReportDate(row.reportRequest.periodEnd),
      inclusive: true,
    },
    createdAt: cloneDate(row.createdAt),
    entries: row.entries.map((entry) => ({
      sourceEntryId: entry.sourceEntryId,
      restaurantName: entry.restaurantName,
      restaurantStatus: entry.restaurantStatus as RestaurantStatus,
      fareAmount: cloneDecimal(entry.fareAmount),
      hasCashOrder: entry.hasCashOrder,
      cashAmount:
        entry.cashAmount === null ? null : cloneDecimal(entry.cashAmount),
      entryDate: toReportDate(entry.entryDate),
      entryTimestamp: cloneDate(entry.entryTimestamp),
    })),
    summary: {
      recordCount: row.recordCount,
      digitalIncomeTotal: cloneDecimal(row.digitalIncomeTotal),
      cashIncomeTotal: cloneDecimal(row.cashIncomeTotal),
      halalIncomeTotal: cloneDecimal(row.halalIncomeTotal),
      nonHalalIncomeTotal: cloneDecimal(row.nonHalalIncomeTotal),
    },
  };
}

function cloneDecimal(value: Prisma.Decimal): Prisma.Decimal {
  return new Prisma.Decimal(value.toString());
}

function zero(): Prisma.Decimal {
  return new Prisma.Decimal(0);
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function databaseDate(value: ReportDateString): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function toReportDate(value: Date): ReportDateString {
  const iso = value.toISOString();
  return iso.slice(0, 10) as ReportDateString;
}

function fromDbReportType(value: DbReportType): ReportType {
  return value === DbReportType.WEEKLY ? "weekly" : "monthly";
}
