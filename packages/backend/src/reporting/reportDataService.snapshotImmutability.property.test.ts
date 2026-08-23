import { Prisma, PrismaClient, ReportType } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock } from "./infrastructure";
import type { ReportSnapshot, ReportSnapshotEntry } from "./models";
import type { ReportTelemetry } from "./observability";
import { ReportDataService } from "./reportDataService";

const USER_ID = "user-property-6";
const REQUEST_ID = "request-property-6";
const SNAPSHOT_ID = "snapshot-property-6";
const PERIOD_START = new Date("2025-01-06T00:00:00.000Z");
const PERIOD_END = new Date("2025-01-12T00:00:00.000Z");
const GENERATED_AT = new Date("2025-01-13T01:02:03.987Z");
const REQUEST = {
  reportType: ReportType.WEEKLY,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
};

interface SourceRow {
  id: string;
  userId: string;
  restaurantName: string;
  restaurantStatus: "halal" | "non-halal";
  fareAmount: Prisma.Decimal;
  hasCashOrder: boolean;
  cashAmount: Prisma.Decimal | null;
  entryDate: Date;
  timestamp: Date;
}

type SnapshotRow = ReturnType<typeof copySnapshotRow>;

const telemetry: ReportTelemetry = { emit: () => undefined };
const clock: Clock = { now: () => new Date(GENERATED_AT) };
class SnapshotPersistenceModel {
  private snapshot: SnapshotRow | null = null;

  constructor(private readonly sources: SourceRow[]) {}

  readonly prisma = {
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>): Promise<T> =>
      operation(this.transactionClient),
    reportSnapshot: {
      findFirst: async () =>
        this.snapshot === null ? null : copySnapshotRow(this.snapshot),
    },
  };

  mutateDeleteAndInsert(): void {
    const mutated = this.sources[0];
    mutated.restaurantName = `mutated-${mutated.restaurantName}`;
    mutated.restaurantStatus = mutated.restaurantStatus === "halal" ? "non-halal" : "halal";
    mutated.fareAmount = new Prisma.Decimal("999999.99");
    mutated.hasCashOrder = false;
    mutated.cashAmount = null;
    mutated.entryDate = new Date(PERIOD_END);
    mutated.timestamp = new Date("2025-01-12T23:59:59.999Z");
    this.sources.splice(1, 1);
    this.sources.push({
      id: "inserted-after-snapshot",
      userId: USER_ID,
      restaurantName: "Inserted Restaurant",
      restaurantStatus: "halal",
      fareAmount: new Prisma.Decimal("777.77"),
      hasCashOrder: true,
      cashAmount: new Prisma.Decimal("22.22"),
      entryDate: new Date(PERIOD_START),
      timestamp: new Date("2025-01-06T00:00:01.000Z"),
    });
  }

  private readonly transactionClient = {
    reportRequest: {
      findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
        where.id === REQUEST_ID && where.userId === USER_ID ? { ...REQUEST } : null,
    },
    reportSnapshot: {
      findUnique: async () =>
        this.snapshot === null ? null : copySnapshotRow(this.snapshot),
      create: async ({ data }: { data: any }) => {
        const created = {
          id: SNAPSHOT_ID,
          reportRequestId: REQUEST_ID,
          createdAt: new Date("2025-01-13T00:00:00.000Z"),
          reportRequest: { ...REQUEST },
          recordCount: data.recordCount,
          digitalIncomeTotal: new Prisma.Decimal(data.digitalIncomeTotal),
          cashIncomeTotal: new Prisma.Decimal(data.cashIncomeTotal),
          halalIncomeTotal: new Prisma.Decimal(data.halalIncomeTotal),
          nonHalalIncomeTotal: new Prisma.Decimal(data.nonHalalIncomeTotal),
          entries: (data.entries?.create ?? []).map((entry: any, index: number) => ({
            id: `snapshot-entry-${index}`,
            snapshotId: SNAPSHOT_ID,
            ...copyPersistedEntry(entry),
          })),
        };
        this.snapshot = copySnapshotRow(created);
        return copySnapshotRow(created);
      },
    },
    deliveryEntry: {
      findMany: async ({ where }: { where: any }) => this.sources
        .filter((row) => row.userId === where.userId &&
          row.entryDate >= where.entryDate.gte && row.entryDate <= where.entryDate.lte)
        .sort(compareSources)
        .map(copySourceRow),
    },
  };
}

function copySourceRow(row: SourceRow): SourceRow {
  return {
    ...row,
    fareAmount: new Prisma.Decimal(row.fareAmount),
    cashAmount: row.cashAmount === null ? null : new Prisma.Decimal(row.cashAmount),
    entryDate: new Date(row.entryDate),
    timestamp: new Date(row.timestamp),
  };
}

function copyPersistedEntry(entry: any) {
  return {
    ...entry,
    fareAmount: new Prisma.Decimal(entry.fareAmount),
    cashAmount: entry.cashAmount === null ? null : new Prisma.Decimal(entry.cashAmount),
    entryDate: new Date(entry.entryDate),
    entryTimestamp: new Date(entry.entryTimestamp),
  };
}
function copySnapshotRow(row: any) {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    reportRequest: {
      ...row.reportRequest,
      periodStart: new Date(row.reportRequest.periodStart),
      periodEnd: new Date(row.reportRequest.periodEnd),
    },
    digitalIncomeTotal: new Prisma.Decimal(row.digitalIncomeTotal),
    cashIncomeTotal: new Prisma.Decimal(row.cashIncomeTotal),
    halalIncomeTotal: new Prisma.Decimal(row.halalIncomeTotal),
    nonHalalIncomeTotal: new Prisma.Decimal(row.nonHalalIncomeTotal),
    entries: row.entries.map(copyPersistedEntry),
  };
}

function compareSources(left: SourceRow, right: SourceRow): number {
  const date = right.entryDate.getTime() - left.entryDate.getTime();
  if (date !== 0) return date;
  const timestamp = right.timestamp.getTime() - left.timestamp.getTime();
  return timestamp !== 0 ? timestamp : left.id.localeCompare(right.id);
}

function exactEntries(entries: readonly ReportSnapshotEntry[]) {
  return entries.map((entry) => ({
    sourceEntryId: entry.sourceEntryId,
    restaurantName: entry.restaurantName,
    restaurantStatus: entry.restaurantStatus,
    fareAmount: entry.fareAmount.toFixed(2),
    hasCashOrder: entry.hasCashOrder,
    cashAmount: entry.cashAmount?.toFixed(2) ?? null,
    entryDate: entry.entryDate,
    entryTimestamp: entry.entryTimestamp.toISOString(),
  }));
}

function exactSummary(snapshot: ReportSnapshot) {
  return {
    recordCount: snapshot.summary.recordCount,
    digitalIncomeTotal: snapshot.summary.digitalIncomeTotal.toFixed(2),
    cashIncomeTotal: snapshot.summary.cashIncomeTotal.toFixed(2),
    halalIncomeTotal: snapshot.summary.halalIncomeTotal.toFixed(2),
    nonHalalIncomeTotal: snapshot.summary.nonHalalIncomeTotal.toFixed(2),
  };
}

const restaurantName = fc.array(
  fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz 0123456789"),
  { minLength: 1, maxLength: 18 },
).map((characters) => characters.join(""));

interface GeneratedEntry {
  restaurantName: string;
  restaurantStatus: "halal" | "non-halal";
  fareCents: number;
  hasCashOrder: boolean;
  cashCents: number;
  storeFalseCash: boolean;
  entryDateOffset: number;
  timestampOffsetSeconds: number;
}

const selectedEntrySet: fc.Arbitrary<GeneratedEntry[]> = fc.array(fc.record({
  restaurantName,
  restaurantStatus: fc.constantFrom<"halal" | "non-halal">("halal", "non-halal"),
  fareCents: fc.integer({ min: 0, max: 10_000_000 }),
  hasCashOrder: fc.boolean(),
  cashCents: fc.integer({ min: 0, max: 10_000_000 }),
  storeFalseCash: fc.boolean(),
  entryDateOffset: fc.integer({ min: 0, max: 6 }),
  timestampOffsetSeconds: fc.integer({ min: 0, max: 604_799 }),
}), { minLength: 2, maxLength: 10 });

function cents(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value).dividedBy(100);
}

function toSources(values: GeneratedEntry[]): SourceRow[] {
  return values.map((value, index) => ({
    id: `selected-entry-${index}`,
    userId: USER_ID,
    restaurantName: value.restaurantName,
    restaurantStatus: value.restaurantStatus,
    fareAmount: cents(value.fareCents),
    hasCashOrder: value.hasCashOrder,
    cashAmount: value.hasCashOrder || value.storeFalseCash ? cents(value.cashCents) : null,
    entryDate: new Date(PERIOD_START.getTime() + value.entryDateOffset * 86_400_000),
    timestamp: new Date(PERIOD_START.getTime() + value.timestampOffsetSeconds * 1_000),
  }));
}

describe("ReportDataService exact immutable snapshot", () => {
  // Feature: bulk-csv-report-email, Property 6: Snapshot is an exact immutable source
  // **Validates: Requirements 3.8, 3.9, 3.10**
  it("keeps copied details, summaries, and CSV bytes unchanged after source changes", async () => {
    await fc.assert(fc.asyncProperty(selectedEntrySet, async (values) => {
      const sources = toSources(values);
      const selectedCopies = sources.map(copySourceRow).sort(compareSources);
      const model = new SnapshotPersistenceModel(sources);
      const dataService = new ReportDataService(
        model.prisma as unknown as PrismaClient,
        { recordFailure: async () => undefined },
        telemetry,
      );
      const generator = new CsvReportGenerator(clock, telemetry);

      const originalSnapshot = await dataService.createSnapshot({
        reportRequestId: REQUEST_ID,
        userId: USER_ID,
      });
      const originalAttachment = generator.generate(originalSnapshot);
      const expectedDetails = selectedCopies.map((row) => ({
        sourceEntryId: row.id,
        restaurantName: row.restaurantName,
        restaurantStatus: row.restaurantStatus,
        fareAmount: row.fareAmount.toFixed(2),
        hasCashOrder: row.hasCashOrder,
        cashAmount: row.cashAmount?.toFixed(2) ?? null,
        entryDate: row.entryDate.toISOString().slice(0, 10),
        entryTimestamp: row.timestamp.toISOString(),
      }));

      expect(exactEntries(originalSnapshot.entries)).toEqual(expectedDetails);
      expect(new Set(originalSnapshot.entries.map((entry) => entry.sourceEntryId)).size)
        .toBe(selectedCopies.length);
      for (const entry of originalSnapshot.entries) {
        const source = selectedCopies.find((row) => row.id === entry.sourceEntryId)!;
        expect(entry.fareAmount).not.toBe(source.fareAmount);
        expect(entry.entryTimestamp).not.toBe(source.timestamp);
      }

      model.mutateDeleteAndInsert();
      const persistedSnapshot = await dataService.readSnapshot({
        reportRequestId: REQUEST_ID,
        userId: USER_ID,
      });
      expect(persistedSnapshot).not.toBeNull();
      const persistedAttachment = generator.generate(persistedSnapshot!);

      expect(exactEntries(persistedSnapshot!.entries)).toEqual(expectedDetails);
      expect(exactSummary(persistedSnapshot!)).toEqual(exactSummary(originalSnapshot));
      expect(persistedAttachment.summary.recordCount).toBe(originalAttachment.summary.recordCount);
      expect(Array.from(persistedAttachment.bytes)).toEqual(Array.from(originalAttachment.bytes));
    }), { numRuns: 150 });
  });
});
