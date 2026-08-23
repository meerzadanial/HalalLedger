import { Prisma } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CsvReportGenerator } from "./csvReportGenerator";
import { ReportDomainError } from "./errors";
import type { Clock } from "./infrastructure";
import type {
  ReportAttachment,
  ReportSnapshot,
  ReportSnapshotEntry,
} from "./models";
import type { ReportTelemetry } from "./observability";
import type { ReportDateString } from "./temporal";

const clock: Clock = { now: () => new Date("2025-01-13T01:02:03.987Z") };
const telemetry: ReportTelemetry = { emit: () => undefined };
const reportDate = (value: string) => value as ReportDateString;

interface GeneratedEntry {
  readonly restaurantName: string;
  readonly restaurantStatus: "halal" | "non-halal";
  readonly fareCents: number;
  readonly hasCashOrder: boolean;
  readonly cashCents: number | null;
  readonly day: number;
  readonly timestampOffset: number;
}

const centsArbitrary = fc.integer({ min: 0, max: 999_999_999_999 });
const entryFields = {
  restaurantName: fc.string(),
  restaurantStatus: fc.constantFrom<"halal" | "non-halal">(
    "halal",
    "non-halal",
  ),
  fareCents: centsArbitrary,
  day: fc.integer({ min: 6, max: 12 }),
  timestampOffset: fc.integer({ min: 0, max: 86_399_999 }),
} as const;

const validEntryArbitrary: fc.Arbitrary<GeneratedEntry> = fc.oneof(
  fc.record({
    ...entryFields,
    hasCashOrder: fc.constant(true),
    cashCents: centsArbitrary,
  }),
  fc.record({
    ...entryFields,
    hasCashOrder: fc.constant(false),
    cashCents: fc.option(centsArbitrary, { nil: null }),
  }),
);

const missingCashEntryArbitrary: fc.Arbitrary<GeneratedEntry> = fc.record({
  ...entryFields,
  hasCashOrder: fc.constant(true),
  cashCents: fc.constant(null),
});

const snapshotArbitrary = fc
  .record({
    reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
    validEntries: fc.array(validEntryArbitrary, { minLength: 0, maxLength: 20 }),
    missingCashEntry: missingCashEntryArbitrary,
    insertionSeed: fc.nat(),
    summaryCents: fc.array(centsArbitrary, { minLength: 4, maxLength: 4 }),
  })
  .map(
    ({
      reportType,
      validEntries,
      missingCashEntry,
      insertionSeed,
      summaryCents,
    }): ReportSnapshot => {
      const generatedEntries = [...validEntries];
      generatedEntries.splice(
        insertionSeed % (generatedEntries.length + 1),
        0,
        missingCashEntry,
      );
      const entries = generatedEntries.map(toSnapshotEntry);
      return {
        id: `snapshot-property-12-${insertionSeed}`,
        reportRequestId: `request-property-12-${insertionSeed}`,
        reportType,
        period: {
          startDate: reportDate("2025-01-06"),
          endDate: reportDate("2025-01-12"),
          inclusive: true,
        },
        createdAt: new Date("2025-01-13T00:00:00.000Z"),
        entries,
        summary: {
          recordCount: entries.length,
          digitalIncomeTotal: decimalFromCents(summaryCents[0]!),
          cashIncomeTotal: decimalFromCents(summaryCents[1]!),
          halalIncomeTotal: decimalFromCents(summaryCents[2]!),
          nonHalalIncomeTotal: decimalFromCents(summaryCents[3]!),
        },
      };
    },
  );

function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal(cents).dividedBy(100);
}

function toSnapshotEntry(
  generated: GeneratedEntry,
  index: number,
): ReportSnapshotEntry {
  return {
    sourceEntryId: `entry-property-12-${index}`,
    restaurantName: generated.restaurantName,
    restaurantStatus: generated.restaurantStatus,
    fareAmount: decimalFromCents(generated.fareCents),
    hasCashOrder: generated.hasCashOrder,
    cashAmount:
      generated.cashCents === null
        ? null
        : decimalFromCents(generated.cashCents),
    entryDate: reportDate(
      `2025-01-${generated.day.toString().padStart(2, "0")}`,
    ),
    entryTimestamp: new Date(
      Date.parse(`2025-01-${generated.day.toString().padStart(2, "0")}T00:00:00.000Z`) +
        generated.timestampOffset,
    ),
  };
}

function cloneSnapshot(snapshot: ReportSnapshot): ReportSnapshot {
  const cloneDecimal = (value: Prisma.Decimal) =>
    new Prisma.Decimal(value.toString());
  return {
    ...snapshot,
    period: { ...snapshot.period },
    createdAt: new Date(snapshot.createdAt.getTime()),
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      fareAmount: cloneDecimal(entry.fareAmount),
      cashAmount:
        entry.cashAmount === null ? null : cloneDecimal(entry.cashAmount),
      entryTimestamp: new Date(entry.entryTimestamp.getTime()),
    })),
    summary: {
      recordCount: snapshot.summary.recordCount,
      digitalIncomeTotal: cloneDecimal(snapshot.summary.digitalIncomeTotal),
      cashIncomeTotal: cloneDecimal(snapshot.summary.cashIncomeTotal),
      halalIncomeTotal: cloneDecimal(snapshot.summary.halalIncomeTotal),
      nonHalalIncomeTotal: cloneDecimal(snapshot.summary.nonHalalIncomeTotal),
    },
  };
}

describe("CsvReportGenerator missing required cash failure", () => {
  // Feature: bulk-csv-report-email, Property 12: Missing required cash fails without mutation
  // **Validates: Requirements 4.18**
  it("returns only the typed failure and preserves the complete snapshot", () => {
    fc.assert(
      fc.property(snapshotArbitrary, (snapshot) => {
        const before = cloneSnapshot(snapshot);
        let attachment: ReportAttachment | undefined;
        let failure: unknown;

        try {
          attachment = new CsvReportGenerator(clock, telemetry).generate(snapshot);
        } catch (error) {
          failure = error;
        }

        expect(attachment).toBeUndefined();
        expect(failure).toBeInstanceOf(ReportDomainError);
        if (!(failure instanceof ReportDomainError)) {
          throw new Error("Expected a typed report-domain failure");
        }
        expect(failure.code).toBe("missing_required_cash_amount");
        expect(failure.stage).toBe("csv_generation");
        expect(snapshot).toStrictEqual(before);
      }),
      { numRuns: 150 },
    );
  });
});