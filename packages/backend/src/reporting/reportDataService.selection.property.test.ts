import { Prisma, PrismaClient, ReportType } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReportDataService } from "./reportDataService";

const REQUEST_ID = "property-request";
const SNAPSHOT_ID = "property-snapshot";
const DASHBOARD_PAGE_SIZE = 10;
const BASE_DAY = Date.parse("2020-01-01T00:00:00.000Z");
const DAY_MS = 86_400_000;

type Status = "halal" | "non-halal";

interface SourceRow {
  readonly id: string;
  readonly userId: string;
  readonly restaurantName: string;
  readonly restaurantStatus: Status;
  readonly fareAmount: Prisma.Decimal;
  readonly hasCashOrder: boolean;
  readonly cashAmount: Prisma.Decimal | null;
  readonly entryDate: Date;
  readonly timestamp: Date;
}

interface QueryArgs {
  readonly where?: Record<string, unknown>;
  readonly orderBy?: readonly Record<string, "asc" | "desc">[];
  readonly select?: Record<string, boolean>;
  readonly skip?: number;
  readonly take?: number;
}

interface GeneratedCase {
  readonly authenticatedUserId: string;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly rows: readonly SourceRow[];
}
function cloneRow(row: SourceRow): SourceRow {
  return {
    ...row,
    fareAmount: new Prisma.Decimal(row.fareAmount.toString()),
    cashAmount: row.cashAmount === null
      ? null
      : new Prisma.Decimal(row.cashAmount.toString()),
    entryDate: new Date(row.entryDate),
    timestamp: new Date(row.timestamp),
  };
}

function compareValues(left: unknown, right: unknown): number {
  const leftValue = left instanceof Date ? left.getTime() : left;
  const rightValue = right instanceof Date ? right.getTime() : right;
  return leftValue! < rightValue! ? -1 : leftValue! > rightValue! ? 1 : 0;
}

function matchesWhere(row: SourceRow, where: Record<string, unknown>): boolean {
  if (where.userId !== undefined && row.userId !== where.userId) return false;
  if (where.restaurantStatus !== undefined
    && row.restaurantStatus !== where.restaurantStatus) return false;
  if (where.hasCashOrder !== undefined
    && row.hasCashOrder !== where.hasCashOrder) return false;

  const date = where.entryDate as { gte?: Date; lte?: Date } | undefined;
  if (date?.gte !== undefined && row.entryDate < date.gte) return false;
  if (date?.lte !== undefined && row.entryDate > date.lte) return false;
  return true;
}

function executeFindMany(rows: readonly SourceRow[], query: QueryArgs): unknown[] {
  let result = rows
    .filter((row) => matchesWhere(row, query.where ?? {}))
    .map(cloneRow);
  const ordering = query.orderBy ?? [];
  result.sort((left, right) => {
    for (const order of ordering) {
      const [field, direction] = Object.entries(order)[0];
      const comparison = compareValues(
        left[field as keyof SourceRow],
        right[field as keyof SourceRow],
      );
      if (comparison !== 0) return direction === "desc" ? -comparison : comparison;
    }
    return 0;
  });
  result = result.slice(query.skip ?? 0);
  if (query.take !== undefined) result = result.slice(0, query.take);

  if (query.select === undefined) return result;
  return result.map((row) => Object.fromEntries(
    Object.entries(query.select)
      .filter(([, included]) => included)
      .map(([field]) => [field, row[field as keyof SourceRow]]),
  ));
}
class FaithfulReportTransactionModel {
  readonly prisma: PrismaClient;

  constructor(
    private readonly authenticatedUserId: string,
    private readonly periodStart: Date,
    private readonly periodEnd: Date,
    private readonly rows: readonly SourceRow[],
  ) {
    const request = {
      reportType: ReportType.WEEKLY,
      periodStart: new Date(periodStart),
      periodEnd: new Date(periodEnd),
    };
    const transaction = {
      reportRequest: {
        findFirst: async ({ where }: { where: { id: string; userId: string } }) =>
          where.id === REQUEST_ID && where.userId === authenticatedUserId
            ? request
            : null,
      },
      reportSnapshot: {
        findUnique: async () => null,
        create: async ({ data }: { data: Record<string, any> }) => ({
          id: SNAPSHOT_ID,
          reportRequestId: REQUEST_ID,
          createdAt: new Date("2030-01-01T00:00:00.000Z"),
          reportRequest: request,
          recordCount: data.recordCount,
          digitalIncomeTotal: data.digitalIncomeTotal,
          cashIncomeTotal: data.cashIncomeTotal,
          halalIncomeTotal: data.halalIncomeTotal,
          nonHalalIncomeTotal: data.nonHalalIncomeTotal,
          entries: (data.entries?.create ?? []).map(
            (entry: Record<string, unknown>, index: number) => ({
              id: `snapshot-entry-${index}`,
              snapshotId: SNAPSHOT_ID,
              ...entry,
            }),
          ),
        }),
      },
      deliveryEntry: {
        findMany: async (query: QueryArgs) => executeFindMany(rows, query),
      },
    };
    this.prisma = {
      reportSnapshot: { findFirst: async () => null },
      $transaction: async (
        operation: (client: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    } as unknown as PrismaClient;
  }
}

function dateAt(dayOffset: number): Date {
  return new Date(BASE_DAY + dayOffset * DAY_MS);
}

function money(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function sourceRow(input: {
  id: string;
  userId: string;
  dayOffset: number;
  status: Status;
  hasCashOrder: boolean;
  cents: number;
}): SourceRow {
  return {
    id: input.id,
    userId: input.userId,
    restaurantName: `Restaurant ${input.id}`,
    restaurantStatus: input.status,
    fareAmount: money(input.cents),
    hasCashOrder: input.hasCashOrder,
    cashAmount: input.hasCashOrder ? money(input.cents % 997) : money(999_999),
    entryDate: dateAt(input.dayOffset),
    timestamp: new Date(dateAt(input.dayOffset).getTime() + (input.cents % 86_400) * 1_000),
  };
}
function permute<T>(values: readonly T[], seed: number): T[] {
  const result = [...values];
  let state = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

const extraArbitrary = fc.record({
  owned: fc.boolean(),
  relativeDay: fc.integer({ min: -8, max: 40 }),
  status: fc.constantFrom<Status>("halal", "non-halal"),
  hasCashOrder: fc.boolean(),
  cents: fc.integer({ min: 0, max: 2_000_000 }),
});

const generatedCaseArbitrary: fc.Arbitrary<GeneratedCase> = fc.record({
  users: fc.tuple(fc.uuid(), fc.uuid())
    .filter(([authenticated, other]) => authenticated !== other),
  startDay: fc.integer({ min: 365, max: 3_000 }),
  span: fc.integer({ min: 2, max: 30 }),
  extras: fc.array(extraArbitrary, { minLength: 0, maxLength: 24 }),
  permutationSeed: fc.integer(),
}).map(({ users, startDay, span, extras, permutationSeed }) => {
  const [authenticatedUserId, otherUserId] = users;
  const selectedCore = Array.from({ length: DASHBOARD_PAGE_SIZE + 2 }, (_, index) => {
    const relativeDay = index === 0
      ? 0
      : index === 1
        ? span
        : 1 + ((index - 2) % (span - 1));
    return sourceRow({
      id: `selected-${index}`,
      userId: authenticatedUserId,
      dayOffset: startDay + relativeDay,
      status: index % 2 === 0 ? "halal" : "non-halal",
      hasCashOrder: index % 3 === 0,
      cents: 100 + index,
    });
  });
  const requiredExclusions = [
    sourceRow({
      id: "foreign-inside",
      userId: otherUserId,
      dayOffset: startDay + 1,
      status: "halal",
      hasCashOrder: true,
      cents: 501,
    }),
    sourceRow({
      id: "owned-before",
      userId: authenticatedUserId,
      dayOffset: startDay - 1,
      status: "non-halal",
      hasCashOrder: false,
      cents: 502,
    }),
    sourceRow({
      id: "owned-after",
      userId: authenticatedUserId,
      dayOffset: startDay + span + 1,
      status: "halal",
      hasCashOrder: true,
      cents: 503,
    }),
  ];
  const generatedExtras = extras.map((extra, index) => sourceRow({
    id: `extra-${index}`,
    userId: extra.owned ? authenticatedUserId : otherUserId,
    dayOffset: startDay + extra.relativeDay,
    status: extra.status,
    hasCashOrder: extra.hasCashOrder,
    cents: extra.cents,
  }));
  return {
    authenticatedUserId,
    periodStart: dateAt(startDay),
    periodEnd: dateAt(startDay + span),
    rows: permute(
      [...selectedCore, ...requiredExclusions, ...generatedExtras],
      permutationSeed,
    ),
  };
});
function independentlySelectedIds(input: GeneratedCase): string[] {
  return input.rows
    .filter((row) => row.userId === input.authenticatedUserId)
    .filter((row) => row.entryDate.getTime() >= input.periodStart.getTime())
    .filter((row) => row.entryDate.getTime() <= input.periodEnd.getTime())
    .map((row) => row.id)
    .sort();
}

describe("ReportDataService exact set selection", () => {
  // Feature: bulk-csv-report-email, Property 5: Report selection is exact set filtering
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7**
  it("matches an independent owner and inclusive-period set model", async () => {
    await fc.assert(fc.asyncProperty(generatedCaseArbitrary, async (input) => {
      const expectedIds = independentlySelectedIds(input);
      const model = new FaithfulReportTransactionModel(
        input.authenticatedUserId,
        input.periodStart,
        input.periodEnd,
        input.rows,
      );
      const service = new ReportDataService(
        model.prisma,
        { recordFailure: async () => undefined },
        { emit: () => undefined },
      );

      const snapshot = await service.createSnapshot({
        reportRequestId: REQUEST_ID,
        userId: input.authenticatedUserId,
      });
      const actualIds = snapshot.entries
        .map((entry) => entry.sourceEntryId)
        .sort();

      expect(expectedIds.length).toBeGreaterThan(DASHBOARD_PAGE_SIZE);
      expect(actualIds).toEqual(expectedIds);
      expect(new Set(actualIds).size).toBe(actualIds.length);
      expect(snapshot.summary.recordCount).toBe(expectedIds.length);
      expect(actualIds).toContain("selected-0");
      expect(actualIds).toContain("selected-1");
      expect(actualIds).not.toContain("foreign-inside");
      expect(actualIds).not.toContain("owned-before");
      expect(actualIds).not.toContain("owned-after");
    }), { numRuns: 150 });
  });
});
