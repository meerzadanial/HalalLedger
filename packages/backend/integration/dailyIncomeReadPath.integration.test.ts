import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDatabase, initializeDatabase } from "../src/database";
import { IncomeService } from "../src/services/IncomeService";
import type { Clock } from "../src/services/incomeQuery";

const databaseUrl = process.env.DATABASE_URL;
const isDisposableDatabase = (() => {
  if (!databaseUrl) return false;
  try {
    return new URL(databaseUrl).pathname.includes("bulk_report_integration_");
  } catch {
    return false;
  }
})();

const describeDisposable = isDisposableDatabase ? describe : describe.skip;

interface ObservedAction {
  readonly model: string | undefined;
  readonly action: string;
}

describeDisposable("IncomeService disposable PostgreSQL read path", () => {
  let prisma: PrismaClient;
  let trackReadPath = false;
  let failNextDeliveryFind = false;
  const observedActions: ObservedAction[] = [];

  beforeAll(async () => {
    const database = await initializeDatabase();
    prisma = database.getClient();
    prisma.$use(async (params, next) => {
      if (trackReadPath) {
        observedActions.push({ model: params.model, action: params.action });
      }
      if (
        trackReadPath &&
        failNextDeliveryFind &&
        params.model === "DeliveryEntry" &&
        params.action === "findMany"
      ) {
        failNextDeliveryFind = false;
        throw new Error("injected disposable database read failure");
      }
      return next(params);
    });
  }, 30_000);

  afterAll(async () => closeDatabase(), 30_000);

  function deliveryEntry(
    userId: string,
    overrides: Partial<Prisma.DeliveryEntryCreateManyInput>,
  ): Prisma.DeliveryEntryCreateManyInput {
    return {
      id: randomUUID(),
      userId,
      restaurantName: "Integration Restaurant",
      restaurantStatus: "halal",
      fareAmount: "1.00",
      hasCashOrder: false,
      cashAmount: null,
      entryDate: new Date("2025-01-11T00:00:00.000Z"),
      timestamp: new Date("2025-01-11T08:00:00.000Z"),
      createdAt: new Date("2025-02-01T00:00:00.000Z"),
      updatedAt: new Date("2025-02-01T00:00:00.000Z"),
      ...overrides,
    };
  }

  async function snapshotAllDeliveryRows() {
    const wasTracking = trackReadPath;
    trackReadPath = false;
    try {
      const rows = await prisma.deliveryEntry.findMany({ orderBy: { id: "asc" } });
      return rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        restaurantName: row.restaurantName,
        restaurantStatus: row.restaurantStatus,
        fareAmount: row.fareAmount.toFixed(2),
        hasCashOrder: row.hasCashOrder,
        cashAmount: row.cashAmount?.toFixed(2) ?? null,
        entryDate: row.entryDate.toISOString(),
        timestamp: row.timestamp.toISOString(),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }));
    } finally {
      trackReadPath = wasTracking;
    }
  }

  it("keeps all rows invariant while enforcing owned daily totals, filters, and deterministic pagination", async () => {
    // Validates: Requirements 1.1-1.3, 2.1-2.2, 3.1-3.2, 4.3-4.7, 6.1-6.5, 6.7-6.9
    const ownerId = randomUUID();
    const otherUserId = randomUUID();
    const fixtureUserIds = [ownerId, otherUserId];
    const tieFirstId = "00000000-0000-4000-8000-000000000101";
    const tieSecondId = "00000000-0000-4000-8000-000000000102";
    const dayBThirdId = "00000000-0000-4000-8000-000000000103";
    const dayAId = "00000000-0000-4000-8000-000000000104";
    const historicalId = "00000000-0000-4000-8000-000000000105";
    const futureId = "00000000-0000-4000-8000-000000000106";
    const tieTimestamp = new Date("2025-01-11T10:00:00.000Z");

    await prisma.$transaction(async (tx) => {
      await tx.user.createMany({
        data: fixtureUserIds.map((id) => ({
          id,
          email: `${id}@daily-income.integration.test`,
          passwordHash: "integration-only",
        })),
      });
      await tx.deliveryEntry.createMany({
        data: [
          deliveryEntry(ownerId, {
            id: tieFirstId,
            restaurantName: "Day B Halal Cash",
            restaurantStatus: "halal",
            fareAmount: "10.10",
            hasCashOrder: true,
            cashAmount: "1.90",
            entryDate: new Date("2025-01-11T00:00:00.000Z"),
            timestamp: tieTimestamp,
          }),
          deliveryEntry(ownerId, {
            id: tieSecondId,
            restaurantName: "Day B Non-Halal Digital",
            restaurantStatus: "non-halal",
            fareAmount: "20.20",
            entryDate: new Date("2025-01-11T00:00:00.000Z"),
            timestamp: tieTimestamp,
          }),
          deliveryEntry(ownerId, {
            id: dayBThirdId,
            restaurantName: "Day B Halal Digital",
            fareAmount: "3.33",
            entryDate: new Date("2025-01-11T00:00:00.000Z"),
            timestamp: new Date("2025-01-11T09:00:00.000Z"),
          }),
          deliveryEntry(ownerId, {
            id: dayAId,
            restaurantName: "Backdated Day A Non-Halal Cash",
            restaurantStatus: "non-halal",
            fareAmount: "4.44",
            hasCashOrder: true,
            cashAmount: "0.56",
            entryDate: new Date("2025-01-10T00:00:00.000Z"),
            timestamp: new Date("2025-01-12T23:59:59.999Z"),
            createdAt: new Date("2025-01-13T00:00:00.000Z"),
            updatedAt: new Date("2025-01-13T00:00:00.000Z"),
          }),
          deliveryEntry(ownerId, {
            id: historicalId,
            restaurantName: "Historical Halal Digital",
            fareAmount: "5.55",
            entryDate: new Date("2025-01-09T00:00:00.000Z"),
          }),
          deliveryEntry(ownerId, {
            id: futureId,
            restaurantName: "Future Non-Halal Cash",
            restaurantStatus: "non-halal",
            fareAmount: "6.66",
            hasCashOrder: true,
            cashAmount: "0.34",
            entryDate: new Date("2025-01-12T00:00:00.000Z"),
          }),
          deliveryEntry(otherUserId, {
            restaurantName: "Other User Boundary Row",
            restaurantStatus: "non-halal",
            fareAmount: "999.99",
            hasCashOrder: true,
            cashAmount: "99.99",
            entryDate: new Date("2025-01-11T00:00:00.000Z"),
            timestamp: tieTimestamp,
          }),
        ],
      });
    });

    try {
      const initialSnapshot = await snapshotAllDeliveryRows();
      let requestInstant = new Date("2025-01-10T15:59:59.999Z");
      const clock: Clock = { now: () => new Date(requestInstant) };
      const service = new IncomeService(clock);
      observedActions.length = 0;
      trackReadPath = true;

      const historicalPage = await service.getEntries(ownerId, {
        limit: 2,
        offset: 1,
      });
      expect(historicalPage.total).toBe(6);
      expect(historicalPage.entries.map((row) => row.id)).toEqual([
        tieFirstId,
        tieSecondId,
      ]);

      const inclusiveRange = {
        startDate: "2025-01-10",
        endDate: "2025-01-11",
      };
      const rangePage = await service.getEntries(ownerId, {
        dateRange: inclusiveRange,
        limit: 100,
        offset: 0,
      });
      expect(rangePage.total).toBe(4);
      expect(rangePage.entries.map((row) => row.id)).toEqual([
        tieFirstId,
        tieSecondId,
        dayBThirdId,
        dayAId,
      ]);

      const filteredPage = await service.getEntries(ownerId, {
        dateRange: inclusiveRange,
        restaurantStatus: "non-halal",
        paymentType: "digital",
        limit: 10,
        offset: 0,
      });
      expect(filteredPage).toMatchObject({ total: 1 });
      expect(filteredPage.entries.map((row) => row.id)).toEqual([tieSecondId]);

      expect(await service.calculateTotals(ownerId)).toEqual({
        totalHalalIncome: 0,
        totalNonHalalIncome: 5,
        totalCashIncome: 0.56,
        totalDigitalIncome: 4.44,
      });
      expect(
        await service.calculateTotals(ownerId, {
          dateRange: inclusiveRange,
          paymentType: "cash",
        }),
      ).toEqual({
        totalHalalIncome: 12,
        totalNonHalalIncome: 5,
        totalCashIncome: 2.46,
        totalDigitalIncome: 14.54,
      });
      expect(
        await service.calculateTotals(ownerId, {
          dateRange: inclusiveRange,
          restaurantStatus: "non-halal",
          paymentType: "digital",
        }),
      ).toEqual({
        totalHalalIncome: 0,
        totalNonHalalIncome: 20.2,
        totalCashIncome: 0,
        totalDigitalIncome: 20.2,
      });

      expect(await snapshotAllDeliveryRows()).toEqual(initialSnapshot);

      failNextDeliveryFind = true;
      await expect(
        service.getEntries(ownerId, { limit: 10, offset: 0 }),
      ).rejects.toThrow("injected disposable database read failure");
      expect(await snapshotAllDeliveryRows()).toEqual(initialSnapshot);

      requestInstant = new Date("2025-01-10T16:00:00.000Z");
      expect(await service.calculateTotals(ownerId)).toEqual({
        totalHalalIncome: 15.33,
        totalNonHalalIncome: 20.2,
        totalCashIncome: 1.9,
        totalDigitalIncome: 33.63,
      });
      expect(await snapshotAllDeliveryRows()).toEqual(initialSnapshot);

      expect(observedActions).toContainEqual({
        model: "DeliveryEntry",
        action: "count",
      });
      expect(observedActions).toContainEqual({
        model: "DeliveryEntry",
        action: "findMany",
      });
      expect(
        observedActions.every(
          ({ model, action }) =>
            model === "DeliveryEntry" &&
            (action === "count" || action === "findMany"),
        ),
      ).toBe(true);
    } finally {
      trackReadPath = false;
      failNextDeliveryFind = false;
      await prisma.$transaction(async (tx) => {
        await tx.user.deleteMany({ where: { id: { in: fixtureUserIds } } });
      });
    }
  }, 30_000);
});
