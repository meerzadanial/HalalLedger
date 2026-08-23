import {
  Prisma,
  PrismaClient,
  ReportType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportDomainError } from "./errors";
import { ReportDataService } from "./reportDataService";

const USER_ID = "user-1";
const REQUEST_ID = "request-1";
const SNAPSHOT_ID = "snapshot-1";
const PERIOD_START = new Date("2025-01-06T00:00:00.000Z");
const PERIOD_END = new Date("2025-01-12T00:00:00.000Z");
const CREATED_AT = new Date("2025-01-13T00:00:00.000Z");

const request = {
  reportType: ReportType.WEEKLY,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
};

function persistedSnapshot(entries: any[], summary: any) {
  return {
    id: SNAPSHOT_ID,
    reportRequestId: REQUEST_ID,
    createdAt: CREATED_AT,
    reportRequest: request,
    entries: entries.map((entry) => ({
      id: `copy-${entry.sourceEntryId}`,
      snapshotId: SNAPSHOT_ID,
      ...entry,
    })),
    ...summary,
  };
}

function makeHarness() {
  const tx = {
    reportRequest: { findFirst: vi.fn() },
    reportSnapshot: { findUnique: vi.fn(), create: vi.fn() },
    deliveryEntry: { findMany: vi.fn() },
  };
  const prisma = {
    reportSnapshot: { findFirst: vi.fn() },
    $transaction: vi.fn(
      async (callback: (client: typeof tx) => unknown, _options: unknown) =>
        callback(tx),
    ),
  };
  const failureRecorder = { recordFailure: vi.fn() };
  const service = new ReportDataService(
    prisma as unknown as PrismaClient,
    failureRecorder,
  );
  return { service, prisma, tx, failureRecorder };
}

function source(overrides: Record<string, unknown> = {}) {
  return {
    id: "entry-1",
    restaurantName: "Cafe One",
    restaurantStatus: "halal",
    fareAmount: new Prisma.Decimal("10.10"),
    hasCashOrder: true,
    cashAmount: new Prisma.Decimal("2.25"),
    entryDate: new Date("2025-01-12T00:00:00.000Z"),
    timestamp: new Date("2025-01-12T08:09:10.123Z"),
    ...overrides,
  };
}

function installCreateResult(tx: ReturnType<typeof makeHarness>["tx"]) {
  tx.reportSnapshot.create.mockImplementation(async ({ data }: any) => {
    const entries = (data.entries?.create ?? []).map((entry: any) => ({
      ...entry,
    }));
    return persistedSnapshot(entries, {
      recordCount: data.recordCount,
      digitalIncomeTotal: data.digitalIncomeTotal,
      cashIncomeTotal: data.cashIncomeTotal,
      halalIncomeTotal: data.halalIncomeTotal,
      nonHalalIncomeTotal: data.nonHalalIncomeTotal,
    });
  });
}

describe("ReportDataService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("selects only ownership and inclusive dates, then snapshots exact values and folds", async () => {
    const { service, prisma, tx, failureRecorder } = makeHarness();
    const rows = [
      source(),
      source({
        id: "entry-2",
        restaurantName: "Cafe Two",
        fareAmount: new Prisma.Decimal("20.20"),
        hasCashOrder: false,
        cashAmount: new Prisma.Decimal("99.99"),
        entryDate: new Date("2025-01-10T00:00:00.000Z"),
      }),
      source({
        id: "entry-3",
        restaurantName: "Cafe Three",
        restaurantStatus: "non-halal",
        fareAmount: new Prisma.Decimal("30.30"),
        cashAmount: new Prisma.Decimal("0.00"),
        entryDate: new Date("2025-01-06T00:00:00.000Z"),
      }),
    ];
    const before = rows.map((row) => ({
      ...row,
      fareAmount: row.fareAmount.toString(),
      cashAmount: row.cashAmount?.toString(),
      entryDate: row.entryDate.getTime(),
      timestamp: row.timestamp.getTime(),
    }));
    tx.reportRequest.findFirst.mockResolvedValue(request);
    tx.reportSnapshot.findUnique.mockResolvedValue(null);
    tx.deliveryEntry.findMany.mockResolvedValue(rows);
    installCreateResult(tx);

    const result = await service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    });

    expect(tx.deliveryEntry.findMany).toHaveBeenCalledWith({
      where: {
        userId: USER_ID,
        entryDate: { gte: PERIOD_START, lte: PERIOD_END },
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
    const query = tx.deliveryEntry.findMany.mock.calls[0][0];
    expect(query).not.toHaveProperty("take");
    expect(query).not.toHaveProperty("skip");
    expect(query.where).not.toHaveProperty("restaurantStatus");
    expect(query.where).not.toHaveProperty("hasCashOrder");
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    expect(result.entries.map((entry) => entry.sourceEntryId)).toEqual([
      "entry-1",
      "entry-2",
      "entry-3",
    ]);
    expect(result.summary.recordCount).toBe(3);
    expect(result.summary.digitalIncomeTotal.toString()).toBe("60.6");
    expect(result.summary.cashIncomeTotal.toString()).toBe("2.25");
    expect(result.summary.halalIncomeTotal.toString()).toBe("32.55");
    expect(result.summary.nonHalalIncomeTotal.toString()).toBe("30.3");

    const copied = tx.reportSnapshot.create.mock.calls[0][0].data.entries.create;
    expect(copied[0].fareAmount).not.toBe(rows[0].fareAmount);
    expect(copied[0].entryDate).not.toBe(rows[0].entryDate);
    expect(copied[0].entryTimestamp).not.toBe(rows[0].timestamp);
    expect(rows.map((row) => ({
      ...row,
      fareAmount: row.fareAmount.toString(),
      cashAmount: row.cashAmount?.toString(),
      entryDate: row.entryDate.getTime(),
      timestamp: row.timestamp.getTime(),
    }))).toEqual(before);
    expect(failureRecorder.recordFailure).not.toHaveBeenCalled();
  });

  it("creates one valid empty snapshot with exact zero totals", async () => {
    const { service, tx } = makeHarness();
    tx.reportRequest.findFirst.mockResolvedValue(request);
    tx.reportSnapshot.findUnique.mockResolvedValue(null);
    tx.deliveryEntry.findMany.mockResolvedValue([]);
    installCreateResult(tx);

    const result = await service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    });

    expect(result.entries).toEqual([]);
    expect(result.summary.recordCount).toBe(0);
    for (const total of [
      result.summary.digitalIncomeTotal,
      result.summary.cashIncomeTotal,
      result.summary.halalIncomeTotal,
      result.summary.nonHalalIncomeTotal,
    ]) {
      expect(total.toFixed(2)).toBe("0.00");
    }
    expect(tx.reportSnapshot.create.mock.calls[0][0].data).not.toHaveProperty(
      "entries",
    );
  });

  it("returns the existing immutable snapshot without re-querying source rows", async () => {
    const { service, tx } = makeHarness();
    tx.reportRequest.findFirst.mockResolvedValue(request);
    tx.reportSnapshot.findUnique.mockResolvedValue(
      persistedSnapshot([], {
        recordCount: 0,
        digitalIncomeTotal: new Prisma.Decimal(0),
        cashIncomeTotal: new Prisma.Decimal(0),
        halalIncomeTotal: new Prisma.Decimal(0),
        nonHalalIncomeTotal: new Prisma.Decimal(0),
      }),
    );

    const result = await service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    });

    expect(result.id).toBe(SNAPSHOT_ID);
    expect(tx.deliveryEntry.findMany).not.toHaveBeenCalled();
    expect(tx.reportSnapshot.create).not.toHaveBeenCalled();
  });

  it("reads snapshots only through the authenticated owner and returns defensive values", async () => {
    const { service, prisma } = makeHarness();
    const entry = source();
    prisma.reportSnapshot.findFirst.mockResolvedValue(
      persistedSnapshot(
        [{
          sourceEntryId: entry.id,
          restaurantName: entry.restaurantName,
          restaurantStatus: entry.restaurantStatus,
          fareAmount: entry.fareAmount,
          hasCashOrder: entry.hasCashOrder,
          cashAmount: entry.cashAmount,
          entryDate: entry.entryDate,
          entryTimestamp: entry.timestamp,
        }],
        {
          recordCount: 1,
          digitalIncomeTotal: entry.fareAmount,
          cashIncomeTotal: entry.cashAmount,
          halalIncomeTotal: entry.fareAmount.plus(entry.cashAmount),
          nonHalalIncomeTotal: new Prisma.Decimal(0),
        },
      ),
    );

    const result = await service.readSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    });

    expect(prisma.reportSnapshot.findFirst).toHaveBeenCalledWith({
      where: {
        reportRequestId: REQUEST_ID,
        reportRequest: { is: { userId: USER_ID } },
      },
      include: expect.objectContaining({ entries: expect.any(Object) }),
    });
    expect(result?.period).toEqual({
      startDate: "2025-01-06",
      endDate: "2025-01-12",
      inclusive: true,
    });
    expect(result?.entries[0].fareAmount).not.toBe(entry.fareAmount);
    expect(result?.entries[0].entryTimestamp).not.toBe(entry.timestamp);
  });

  it("records data retrieval failures only after the transaction rejects", async () => {
    const { service, prisma, tx, failureRecorder } = makeHarness();
    tx.reportRequest.findFirst.mockResolvedValue(request);
    tx.reportSnapshot.findUnique.mockResolvedValue(null);
    tx.deliveryEntry.findMany.mockRejectedValue(new Error("database secret"));

    await expect(service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({
      code: "data_retrieval_failed",
      stage: "data_retrieval",
      message: "Report data retrieval failed.",
    });

    expect(failureRecorder.recordFailure).toHaveBeenCalledOnce();
    expect(failureRecorder.recordFailure.mock.calls[0][0]).toMatchObject({
      reportRequestId: REQUEST_ID,
      failure: { code: "data_retrieval_failed", stage: "data_retrieval" },
    });
    expect(
      prisma.$transaction.mock.invocationCallOrder[0],
    ).toBeLessThan(failureRecorder.recordFailure.mock.invocationCallOrder[0]);
    expect(tx.reportSnapshot.create).not.toHaveBeenCalled();
  });

  it("rolls back partial snapshot work and records the snapshot failure stage", async () => {
    const { service, prisma, tx, failureRecorder } = makeHarness();
    const row = source();
    const original = {
      fareAmount: row.fareAmount.toString(),
      cashAmount: row.cashAmount?.toString(),
      entryDate: row.entryDate.getTime(),
      timestamp: row.timestamp.getTime(),
    };
    tx.reportRequest.findFirst.mockResolvedValue(request);
    tx.reportSnapshot.findUnique.mockResolvedValue(null);
    tx.deliveryEntry.findMany.mockResolvedValue([row]);
    tx.reportSnapshot.create.mockRejectedValue(new Error("insert failed"));

    await expect(service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: USER_ID,
    })).rejects.toMatchObject({
      code: "snapshot_failed",
      stage: "snapshot",
      message: "Report snapshot creation failed.",
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(failureRecorder.recordFailure).toHaveBeenCalledWith({
      reportRequestId: REQUEST_ID,
      failure: expect.objectContaining({
        code: "snapshot_failed",
        stage: "snapshot",
      }),
    });
    expect({
      fareAmount: row.fareAmount.toString(),
      cashAmount: row.cashAmount?.toString(),
      entryDate: row.entryDate.getTime(),
      timestamp: row.timestamp.getTime(),
    }).toEqual(original);
  });

  it("does not record a processing failure when ownership lookup finds no request", async () => {
    const { service, tx, failureRecorder } = makeHarness();
    tx.reportRequest.findFirst.mockResolvedValue(null);

    await expect(service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: "another-user",
    })).rejects.toBeInstanceOf(ReportDomainError);
    await expect(service.createSnapshot({
      reportRequestId: REQUEST_ID,
      userId: "another-user",
    })).rejects.toMatchObject({ code: "report_not_found" });
    expect(failureRecorder.recordFailure).not.toHaveBeenCalled();
  });
});
