import type { PrismaClient } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ReportPeriodResolutionError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { ReportPeriodResolver } from "./reportPeriodResolver";
import { ReportRequestService } from "./reportRequestService";

const NOW = new Date("2025-01-15T12:00:00.000Z");
const USER_ID = "property-user";
const VALID_REFERENCE_DATE = "2025-01-15";
const clock: Clock = { now: () => new Date(NOW) };
const ids: IdGenerator = {
  generate: () => "11111111-1111-4111-8111-111111111111",
};

type Row = Record<string, unknown>;
interface DatabaseState {
  requests: Row[];
  snapshots: Row[];
  attachments: Row[];
  deliveries: Row[];
  jobs: Row[];
  audits: Row[];
}

function emptyState(): DatabaseState {
  return {
    requests: [], snapshots: [], attachments: [], deliveries: [], jobs: [], audits: [],
  };
}

function cloneState(state: DatabaseState): DatabaseState {
  return {
    requests: [...state.requests], snapshots: [...state.snapshots],
    attachments: [...state.attachments], deliveries: [...state.deliveries],
    jobs: [...state.jobs], audits: [...state.audits],
  };
}
function makeTransactionalDatabase() {
  let committed = emptyState();
  const transactionClient = (state: DatabaseState) => ({
    user: {
      findUnique: async () => ({
        id: USER_ID,
        email: "property@example.com",
        timeZone: "UTC",
      }),
    },
    reportRequest: {
      findUnique: async () => null,
      findFirst: async () => null,
      create: async ({ data }: { data: Row }) => {
        const row = {
          ...data,
          createdAt: NOW,
          updatedAt: NOW,
          sentAt: null,
          failureCode: null,
          delivery: null,
        };
        state.requests.push(row);
        return row;
      },
    },
    reportJob: {
      upsert: async ({ create }: { create: Row }) => {
        state.jobs.push(create);
        return create;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.audits.push(data);
        return data;
      },
    },
  });
  const root = transactionClient(committed);
  const client = {
    ...root,
    $transaction: async (callback: (tx: ReturnType<typeof transactionClient>) => unknown) => {
      const working = cloneState(committed);
      const result = await callback(transactionClient(working));
      committed = working;
      return result;
    },
  } as unknown as PrismaClient;

  return {
    client,
    counts: () => ({
      requests: committed.requests.length,
      snapshots: committed.snapshots.length,
      attachments: committed.attachments.length,
      deliveries: committed.deliveries.length,
      jobs: committed.jobs.length,
      audits: committed.audits.length,
    }),
  };
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function formatDate(year: number, month: number, day: number): string {
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}
const invalidReportTypeArbitrary = fc.oneof(
  fc.string({ minLength: 1, maxLength: 16 })
    .filter((value) => value !== "weekly" && value !== "monthly"),
  fc.integer(),
  fc.boolean(),
);
const malformedDateArbitrary = fc.oneof(
  fc.constantFrom("15-01-2025", "2025/01/15", "2025-1-15", "not-a-date"),
  fc.string({ minLength: 1, maxLength: 16 })
    .filter((value) => !/^\d{4}-\d{2}-\d{2}$/.test(value)),
);
const nonexistentDateArbitrary = fc.record({
  year: fc.integer({ min: 1, max: 9_999 }),
  month: fc.integer({ min: 1, max: 12 }),
}).chain(({ year, month }) => fc.integer({
  min: daysInMonth(year, month) + 1,
  max: 35,
}).map((day) => formatDate(year, month, day)));
const futureDateArbitrary = fc.integer({ min: 1, max: 3_000 }).map((days) => {
  const future = new Date(Date.UTC(2025, 0, 15 + days));
  return future.toISOString().slice(0, 10);
});

describe("ReportRequestService invalid command persistence isolation", () => {
  // Feature: bulk-csv-report-email, Property 21: Invalid commands have no persistence effect
  // **Validates: Requirements 7.2, 7.3**
  it("returns typed validation errors without committing requests, artifacts, deliveries, or jobs", async () => {
    await fc.assert(fc.asyncProperty(fc.record({
      absentReportType: fc.constantFrom<undefined | null | "">(undefined, null, ""),
      invalidReportType: invalidReportTypeArbitrary,
      reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
      absentDate: fc.constantFrom<undefined | null | "">(undefined, null, ""),
      malformedDate: malformedDateArbitrary,
      nonexistentDate: nonexistentDateArbitrary,
      futureDate: futureDateArbitrary,
      clientRequestId: fc.uuid(),
    }), async (sample) => {
      const database = makeTransactionalDatabase();
      const service = new ReportRequestService(
        database.client,
        new ReportPeriodResolver(clock),
        clock,
        ids,
      );
      const commands = [
        { reportType: sample.absentReportType, referenceDate: VALID_REFERENCE_DATE, code: "invalid_report_type", reason: "report_type" },
        { reportType: sample.invalidReportType, referenceDate: VALID_REFERENCE_DATE, code: "invalid_report_type", reason: "report_type" },
        { reportType: sample.reportType, referenceDate: sample.absentDate, code: "missing_reference_date", reason: "missing" },
        { reportType: sample.reportType, referenceDate: sample.malformedDate, code: "invalid_reference_date", reason: "malformed" },
        { reportType: sample.reportType, referenceDate: sample.nonexistentDate, code: "invalid_reference_date", reason: "nonexistent" },
        { reportType: sample.reportType, referenceDate: sample.futureDate, code: "future_reference_date", reason: "future_date" },
      ] as const;

      for (const command of commands) {
        let thrown: unknown;
        try {
          await service.create({
            userId: USER_ID,
            clientRequestId: sample.clientRequestId,
            reportType: command.reportType,
            referenceDate: command.referenceDate,
          } as never);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(ReportPeriodResolutionError);
        expect(thrown).toMatchObject({
          code: command.code,
          reason: command.reason,
          httpStatus: 400,
        });
        expect(database.counts()).toEqual({
          requests: 0, snapshots: 0, attachments: 0,
          deliveries: 0, jobs: 0, audits: 0,
        });
      }
    }), { numRuns: 200 });
  });
});
