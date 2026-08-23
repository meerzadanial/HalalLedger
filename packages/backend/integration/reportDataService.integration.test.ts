import { randomUUID } from "node:crypto";
import {
  Prisma,
  PrismaClient,
  ReportFailureStage,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CsvReportGenerator } from "../src/reporting/csvReportGenerator";
import type { Clock } from "../src/reporting/infrastructure";
import { ReportDataService } from "../src/reporting/reportDataService";
import { ReportPeriodResolver } from "../src/reporting/reportPeriodResolver";
import { ReportRequestService } from "../src/reporting/reportRequestService";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.includes("bulk_report_integration_")) {
  throw new Error("Report data integration tests require the generated disposable database.");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const clock: Clock = { now: () => new Date("2025-01-13T01:02:03.456Z") };

beforeAll(async () => prisma.$connect(), 30_000);
afterAll(async () => prisma.$disconnect(), 30_000);

async function createUser(): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: { id, email: `${id}@example.test`, passwordHash: "integration-only" },
  });
  return id;
}

async function createRequest(userId: string) {
  return prisma.reportRequest.create({
    data: {
      id: randomUUID(),
      userId,
      clientRequestId: randomUUID(),
      reportType: ReportType.WEEKLY,
      referenceDate: new Date("2025-01-08T00:00:00.000Z"),
      periodStart: new Date("2025-01-06T00:00:00.000Z"),
      periodEnd: new Date("2025-01-12T00:00:00.000Z"),
      accountEmail: `${userId}@example.test`,
      timeZone: "Asia/Kuala_Lumpur",
      status: ReportStatus.PENDING,
      progressStage: "data_retrieval",
    },
  });
}

function dataService(client: PrismaClient = prisma): ReportDataService {
  return new ReportDataService(
    client,
    new ReportRequestService(
      prisma,
      new ReportPeriodResolver(clock),
      clock,
    ),
  );
}

function entry(
  userId: string,
  overrides: Partial<Prisma.DeliveryEntryCreateManyInput> = {},
): Prisma.DeliveryEntryCreateManyInput {
  return {
    id: randomUUID(),
    userId,
    restaurantName: "Integration Cafe",
    restaurantStatus: "halal",
    fareAmount: "10.00",
    hasCashOrder: false,
    cashAmount: null,
    entryDate: new Date("2025-01-08T00:00:00.000Z"),
    timestamp: new Date("2025-01-08T08:00:00.000Z"),
    ...overrides,
  };
}

function sourceValue(row: {
  id: string;
  restaurantName: string;
  restaurantStatus: string;
  fareAmount: Prisma.Decimal;
  hasCashOrder: boolean;
  cashAmount: Prisma.Decimal | null;
  entryDate: Date;
  timestamp: Date;
}) {
  return {
    id: row.id,
    restaurantName: row.restaurantName,
    restaurantStatus: row.restaurantStatus,
    fareAmount: row.fareAmount.toFixed(2),
    hasCashOrder: row.hasCashOrder,
    cashAmount: row.cashAmount?.toFixed(2) ?? null,
    entryDate: row.entryDate.toISOString(),
    timestamp: row.timestamp.toISOString(),
  };
}

function compareEntries(
  left: Prisma.DeliveryEntryCreateManyInput,
  right: Prisma.DeliveryEntryCreateManyInput,
): number {
  const leftDate = (left.entryDate as Date).getTime();
  const rightDate = (right.entryDate as Date).getTime();
  if (leftDate !== rightDate) return rightDate - leftDate;
  const leftTimestamp = (left.timestamp as Date).getTime();
  const rightTimestamp = (right.timestamp as Date).getTime();
  if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp;
  return String(left.id).localeCompare(String(right.id));
}

function expectedSummary(rows: readonly Prisma.DeliveryEntryCreateManyInput[]) {
  let digital = new Prisma.Decimal(0);
  let cash = new Prisma.Decimal(0);
  let halal = new Prisma.Decimal(0);
  let nonHalal = new Prisma.Decimal(0);
  for (const row of rows) {
    const fare = new Prisma.Decimal(row.fareAmount.toString());
    const includedCash = row.hasCashOrder && row.cashAmount !== null
      ? new Prisma.Decimal(row.cashAmount.toString())
      : new Prisma.Decimal(0);
    const total = fare.plus(includedCash);
    digital = digital.plus(fare);
    cash = cash.plus(includedCash);
    if (row.restaurantStatus === "halal") halal = halal.plus(total);
    if (row.restaurantStatus === "non-halal") nonHalal = nonHalal.plus(total);
  }
  return { digital, cash, halal, nonHalal };
}

describe("ReportDataService PostgreSQL data scope", () => {
  it("selects the exact owner/date set without status, cash, or dashboard page limits and orders ties deterministically", async () => {
    const ownerId = await createUser();
    const otherId = await createUser();
    const request = await createRequest(ownerId);
    const tieTimestamp = new Date("2025-01-12T10:00:00.000Z");
    const tieFirstId = "00000000-0000-4000-8000-000000000001";
    const tieSecondId = "00000000-0000-4000-8000-000000000002";
    const selectedCore = [
      entry(ownerId, {
        id: tieSecondId,
        restaurantName: "End Non-Halal Cash",
        restaurantStatus: "non-halal",
        fareAmount: "12.25",
        hasCashOrder: true,
        cashAmount: "2.75",
        entryDate: new Date("2025-01-12T00:00:00.000Z"),
        timestamp: tieTimestamp,
      }),
      entry(ownerId, {
        id: tieFirstId,
        restaurantName: "End Halal Digital",
        restaurantStatus: "halal",
        fareAmount: "8.50",
        hasCashOrder: false,
        cashAmount: "99.99",
        entryDate: new Date("2025-01-12T00:00:00.000Z"),
        timestamp: tieTimestamp,
      }),
      entry(ownerId, {
        restaurantName: "Interior Zero Cash",
        restaurantStatus: "halal",
        fareAmount: "5.10",
        hasCashOrder: true,
        cashAmount: "0.00",
        entryDate: new Date("2025-01-09T00:00:00.000Z"),
      }),
      entry(ownerId, {
        restaurantName: "Start Non-Halal Digital",
        restaurantStatus: "non-halal",
        fareAmount: "7.15",
        hasCashOrder: false,
        cashAmount: null,
        entryDate: new Date("2025-01-06T00:00:00.000Z"),
      }),
    ];
    const aboveDashboardPage = Array.from({ length: 101 }, (_, index) => entry(ownerId, {
      restaurantName: `Bulk ${index}`,
      restaurantStatus: index % 2 === 0 ? "halal" : "non-halal",
      fareAmount: "1.00",
      hasCashOrder: index % 3 === 0,
      cashAmount: index % 3 === 0 ? "0.50" : null,
      entryDate: new Date("2025-01-08T00:00:00.000Z"),
      timestamp: new Date(`2025-01-08T08:${String(index % 60).padStart(2, "0")}:00.000Z`),
    }));
    const excluded = [
      entry(ownerId, { restaurantName: "Before", entryDate: new Date("2025-01-05T00:00:00.000Z") }),
      entry(ownerId, { restaurantName: "After", entryDate: new Date("2025-01-13T00:00:00.000Z") }),
      entry(otherId, {
        restaurantName: "Other User Boundary",
        restaurantStatus: "non-halal",
        hasCashOrder: true,
        cashAmount: "50.00",
        entryDate: new Date("2025-01-12T00:00:00.000Z"),
      }),
    ];
    const selected = [...selectedCore, ...aboveDashboardPage];
    await prisma.deliveryEntry.createMany({ data: [...selected, ...excluded] });
    const before = (await prisma.deliveryEntry.findMany({
      where: { userId: ownerId },
      orderBy: { id: "asc" },
    })).map(sourceValue);

    const snapshot = await dataService().createSnapshot({
      reportRequestId: request.id,
      userId: ownerId,
    });

    expect(snapshot.entries).toHaveLength(105);
    expect(snapshot.entries.map((row) => row.sourceEntryId)).toEqual(
      [...selected].sort(compareEntries).map((row) => row.id),
    );
    expect(snapshot.entries.slice(0, 2).map((row) => row.sourceEntryId)).toEqual([
      tieFirstId,
      tieSecondId,
    ]);
    expect(new Set(snapshot.entries.map((row) => row.sourceEntryId))).toEqual(
      new Set(selected.map((row) => row.id as string)),
    );
    expect(snapshot.entries.some((row) => row.entryDate === "2025-01-06")).toBe(true);
    expect(snapshot.entries.some((row) => row.entryDate === "2025-01-12")).toBe(true);
    expect(snapshot.entries.some((row) => row.restaurantStatus === "halal" && row.hasCashOrder)).toBe(true);
    expect(snapshot.entries.some((row) => row.restaurantStatus === "non-halal" && !row.hasCashOrder)).toBe(true);

    const totals = expectedSummary(selected);
    expect(snapshot.summary.recordCount).toBe(selected.length);
    expect(snapshot.summary.digitalIncomeTotal.equals(totals.digital)).toBe(true);
    expect(snapshot.summary.cashIncomeTotal.equals(totals.cash)).toBe(true);
    expect(snapshot.summary.halalIncomeTotal.equals(totals.halal)).toBe(true);
    expect(snapshot.summary.nonHalalIncomeTotal.equals(totals.nonHalal)).toBe(true);
    expect((await prisma.deliveryEntry.findMany({
      where: { userId: ownerId },
      orderBy: { id: "asc" },
    })).map(sourceValue)).toEqual(before);
  });

  it("creates exactly one empty snapshot with zero persisted totals", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    await prisma.deliveryEntry.create({
      data: entry(userId, { entryDate: new Date("2025-02-01T00:00:00.000Z") }) as Prisma.DeliveryEntryUncheckedCreateInput,
    });

    const service = dataService();
    const snapshot = await service.createSnapshot({ reportRequestId: request.id, userId });
    const repeated = await service.createSnapshot({ reportRequestId: request.id, userId });

    expect(repeated.id).toBe(snapshot.id);
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.summary.recordCount).toBe(0);
    expect(snapshot.summary.digitalIncomeTotal.toFixed(2)).toBe("0.00");
    expect(snapshot.summary.cashIncomeTotal.toFixed(2)).toBe("0.00");
    expect(snapshot.summary.halalIncomeTotal.toFixed(2)).toBe("0.00");
    expect(snapshot.summary.nonHalalIncomeTotal.toFixed(2)).toBe("0.00");
    expect(await prisma.reportSnapshot.count({ where: { reportRequestId: request.id } })).toBe(1);
    expect(await prisma.reportSnapshotEntry.count({ where: { snapshotId: snapshot.id } })).toBe(0);
  });

  it("keeps persisted snapshot details, totals, and CSV output after source mutation and deletion", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    const mutatedId = "00000000-0000-4000-8000-000000000102";
    const deletedId = "00000000-0000-4000-8000-000000000101";
    await prisma.deliveryEntry.createMany({ data: [
      entry(userId, {
        id: mutatedId,
        restaurantName: "Original Cafe",
        fareAmount: "10.25",
        hasCashOrder: true,
        cashAmount: "1.75",
      }),
      entry(userId, {
        id: deletedId,
        restaurantName: "Delete Later",
        restaurantStatus: "non-halal",
        fareAmount: "20.00",
      }),
    ] });
    const service = dataService();
    const snapshot = await service.createSnapshot({ reportRequestId: request.id, userId });
    const generator = new CsvReportGenerator(clock);
    const originalOutput = generator.generate(snapshot);

    await prisma.deliveryEntry.update({
      where: { id: mutatedId },
      data: { restaurantName: "Mutated Cafe", fareAmount: "999.99", entryDate: new Date("2025-02-01T00:00:00.000Z") },
    });
    await prisma.deliveryEntry.delete({ where: { id: deletedId } });
    await prisma.deliveryEntry.create({
      data: entry(userId, { restaurantName: "Inserted Later" }) as Prisma.DeliveryEntryUncheckedCreateInput,
    });

    const persisted = await service.readSnapshot({ reportRequestId: request.id, userId });
    expect(persisted).not.toBeNull();
    const laterOutput = generator.generate(persisted!);
    expect(persisted!.entries.map((row) => row.restaurantName)).toEqual([
      "Delete Later",
      "Original Cafe",
    ]);
    expect(persisted!.summary.recordCount).toBe(2);
    expect(persisted!.summary.digitalIncomeTotal.toFixed(2)).toBe("30.25");
    expect(Buffer.from(laterOutput.bytes)).toEqual(Buffer.from(originalOutput.bytes));
    expect(laterOutput.sha256).toBe(originalOutput.sha256);
    const csv = Buffer.from(laterOutput.bytes).toString("utf8");
    expect(csv).toContain("Original Cafe");
    expect(csv).toContain("Delete Later");
    expect(csv).not.toContain("Mutated Cafe");
    expect(csv).not.toContain("Inserted Later");
  });
});

describe("ReportDataService PostgreSQL failure isolation", () => {
  it("maps an injected source query failure, records the safe failed stage, and preserves source rows", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    await prisma.deliveryEntry.create({ data: entry(userId) as Prisma.DeliveryEntryUncheckedCreateInput });
    const before = (await prisma.deliveryEntry.findMany({ where: { userId } })).map(sourceValue);
    const failingClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
    failingClient.$use(async (params, next) => {
      if (params.model === "DeliveryEntry" && params.action === "findMany") {
        throw new Error("injected-query-secret-must-not-escape");
      }
      return next(params);
    });
    await failingClient.$connect();

    try {
      await expect(dataService(failingClient).createSnapshot({
        reportRequestId: request.id,
        userId,
      })).rejects.toMatchObject({
        code: "data_retrieval_failed",
        stage: "data_retrieval",
        message: "Report data retrieval failed.",
      });
      const failed = await prisma.reportRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(failed).toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.DATA_RETRIEVAL,
        failureCode: "data_retrieval_failed",
      });
      expect(await prisma.reportSnapshot.count({ where: { reportRequestId: request.id } })).toBe(0);
      expect((await prisma.deliveryEntry.findMany({ where: { userId } })).map(sourceValue)).toEqual(before);
      expect(await prisma.auditLog.count({
        where: { entityId: request.id, action: "report_request.terminal" },
      })).toBe(1);
    } finally {
      await failingClient.$disconnect();
    }
  });

  it("rolls back partial snapshot rows, records snapshot failure safely, and leaves source entries unchanged", async () => {
    const userId = await createUser();
    const request = await createRequest(userId);
    const suffix = randomUUID().replaceAll("-", "");
    const marker = `FAIL_SNAPSHOT_${suffix}`;
    const functionName = `fail_snapshot_${suffix}`;
    const triggerName = `fail_snapshot_${suffix}`;
    await prisma.deliveryEntry.createMany({ data: [
      entry(userId, { restaurantName: "Safe Source", fareAmount: "10.25" }),
      entry(userId, {
        restaurantName: marker,
        restaurantStatus: "non-halal",
        fareAmount: "20.50",
        hasCashOrder: true,
        cashAmount: "2.00",
      }),
    ] });
    const before = (await prisma.deliveryEntry.findMany({
      where: { userId }, orderBy: { id: "asc" },
    })).map(sourceValue);
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        IF NEW.restaurant_name = '${marker}' THEN
          RAISE EXCEPTION 'injected snapshot failure with secret' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON report_snapshot_entries
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);

    try {
      await expect(dataService().createSnapshot({
        reportRequestId: request.id,
        userId,
      })).rejects.toMatchObject({
        code: "snapshot_failed",
        stage: "snapshot",
        message: "Report snapshot creation failed.",
      });
      const failed = await prisma.reportRequest.findUniqueOrThrow({ where: { id: request.id } });
      expect(failed).toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.SNAPSHOT,
        failureCode: "snapshot_failed",
      });
      expect(await prisma.reportSnapshot.count({ where: { reportRequestId: request.id } })).toBe(0);
      expect(await prisma.reportSnapshotEntry.count({
        where: { snapshot: { reportRequestId: request.id } },
      })).toBe(0);
      expect((await prisma.deliveryEntry.findMany({
        where: { userId }, orderBy: { id: "asc" },
      })).map(sourceValue)).toEqual(before);
      expect(await prisma.auditLog.count({
        where: { entityId: request.id, action: "report_request.terminal" },
      })).toBe(1);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "${triggerName}" ON report_snapshot_entries`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }
  });
});
