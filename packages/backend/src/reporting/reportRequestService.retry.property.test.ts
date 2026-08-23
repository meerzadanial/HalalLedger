import {
  PrismaClient,
  ReportFailureStage,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Clock, IdGenerator } from "./infrastructure";
import { ReportPeriodResolver } from "./reportPeriodResolver";
import { ReportRequestService } from "./reportRequestService";
import type { ReportDateString } from "./temporal";

interface PersistedRequest {
  id: string;
  userId: string;
  clientRequestId: string;
  retryOfId: string | null;
  reportType: ReportType;
  referenceDate: Date;
  periodStart: Date;
  periodEnd: Date;
  accountEmail: string;
  timeZone: string;
  status: ReportStatus;
  progressStage: string;
  failureStage: ReportFailureStage | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: Date | null;
  delivery: null;
}

interface ModelState {
  requests: Map<string, PersistedRequest>;
  jobs: Map<string, Record<string, unknown>>;
  audits: Record<string, unknown>[];
}

interface GeneratedCase {
  ids: readonly [string, string, string, string, string];
  reportType: "weekly" | "monthly";
  referenceDate: ReportDateString;
  originalEmail: string;
  currentEmail: string;
  originalTimeZone: string;
  currentTimeZone: string;
  progressStage: string;
  failure: readonly [ReportFailureStage, string];
  createdAt: Date;
  updatedAt: Date;
  replayCount: number;
}
const NOW = new Date("2031-01-01T00:00:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };
const TERMINAL = new Set([ReportStatus.FAILED, ReportStatus.SENT]);

function copyRequest(request: PersistedRequest): PersistedRequest {
  return structuredClone(request);
}

function cloneState(state: ModelState): ModelState {
  return {
    requests: new Map([...state.requests].map(([id, request]) => [id, copyRequest(request)])),
    jobs: new Map([...state.jobs].map(([id, job]) => [id, structuredClone(job)])),
    audits: structuredClone(state.audits),
  };
}

function persistedFields(request: PersistedRequest): Omit<PersistedRequest, "delivery"> {
  return {
    id: request.id,
    userId: request.userId,
    clientRequestId: request.clientRequestId,
    retryOfId: request.retryOfId,
    reportType: request.reportType,
    referenceDate: request.referenceDate,
    periodStart: request.periodStart,
    periodEnd: request.periodEnd,
    accountEmail: request.accountEmail,
    timeZone: request.timeZone,
    status: request.status,
    progressStage: request.progressStage,
    failureStage: request.failureStage,
    failureCode: request.failureCode,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt,
    sentAt: request.sentAt,
  };
}

class TransactionalReportModel {
  private state: ModelState;

  readonly prisma: PrismaClient;

  constructor(
    private readonly user: { id: string; email: string; timeZone: string },
    original: PersistedRequest,
  ) {
    this.state = {
      requests: new Map([[original.id, copyRequest(original)]]),
      jobs: new Map(),
      audits: [],
    };
    this.prisma = {
      $transaction: async (operation: (tx: unknown) => Promise<unknown>) => {
        const draft = cloneState(this.state);
        const result = await operation(this.transactionClient(draft));
        this.state = draft;
        return result;
      },
      reportRequest: {
        findUnique: async () => null,
        findFirst: async () => null,
      },
    } as unknown as PrismaClient;
  }

  get requests(): readonly PersistedRequest[] {
    return [...this.state.requests.values()].map(copyRequest);
  }

  get jobs(): readonly Record<string, unknown>[] {
    return [...this.state.jobs.values()].map((job) => structuredClone(job));
  }

  get audits(): readonly Record<string, unknown>[] {
    return structuredClone(this.state.audits);
  }

  request(id: string): PersistedRequest {
    const request = this.state.requests.get(id);
    if (request === undefined) throw new Error(`Missing request ${id}`);
    return copyRequest(request);
  }
  private transactionClient(draft: ModelState): unknown {
    return {
      user: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          where.id === this.user.id ? structuredClone(this.user) : null,
      },
      reportRequest: {
        findUnique: async ({ where }: { where: Record<string, unknown> }) => {
          const composite = where.userId_clientRequestId as
            | { userId: string; clientRequestId: string }
            | undefined;
          if (composite !== undefined) {
            return [...draft.requests.values()].find((request) =>
              request.userId === composite.userId
              && request.clientRequestId === composite.clientRequestId) ?? null;
          }
          const id = where.id as string | undefined;
          return id === undefined ? null : draft.requests.get(id) ?? null;
        },
        findFirst: async ({ where }: { where: Record<string, unknown> }) => {
          const id = where.id as string | undefined;
          const userId = where.userId as string | undefined;
          if (id !== undefined) {
            const request = draft.requests.get(id);
            return request?.userId === userId ? request : null;
          }
          return [...draft.requests.values()].find((request) =>
            request.userId === userId && !TERMINAL.has(request.status)) ?? null;
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const created: PersistedRequest = {
            id: data.id as string,
            userId: data.userId as string,
            clientRequestId: data.clientRequestId as string,
            retryOfId: data.retryOfId as string | null,
            reportType: data.reportType as ReportType,
            referenceDate: data.referenceDate as Date,
            periodStart: data.periodStart as Date,
            periodEnd: data.periodEnd as Date,
            accountEmail: data.accountEmail as string,
            timeZone: data.timeZone as string,
            status: data.status as ReportStatus,
            progressStage: data.progressStage as string,
            failureStage: null,
            failureCode: null,
            createdAt: new Date(NOW),
            updatedAt: new Date(NOW),
            sentAt: null,
            delivery: null,
          };
          draft.requests.set(created.id, created);
          return created;
        },
      },
      reportJob: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          const existing = draft.jobs.get(create.reportRequestId as string);
          if (existing !== undefined) return existing;
          const job = {
            ...create,
            leaseOwner: null,
            leaseExpiresAt: null,
            attemptCount: 0,
            lastErrorCode: null,
            completedAt: null,
            createdAt: new Date(NOW),
            updatedAt: new Date(NOW),
          };
          draft.jobs.set(create.reportRequestId as string, job);
          return job;
        },
      },
      auditLog: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          draft.audits.push(structuredClone(data));
          return data;
        },
      },
    };
  }
}
const referenceDateArbitrary = fc.integer({ min: 0, max: 3_650 }).map((days) =>
  new Date(Date.UTC(2020, 0, 1 + days)).toISOString().slice(0, 10) as ReportDateString);
const timestampArbitrary = fc.integer({
  min: Date.parse("2018-01-01T00:00:00.000Z"),
  max: Date.parse("2030-12-31T23:59:59.999Z"),
}).map((timestamp) => new Date(timestamp));
const failureArbitrary = fc.constantFrom<readonly [ReportFailureStage, string]>(
  [ReportFailureStage.DATA_RETRIEVAL, "data_retrieval_failed"],
  [ReportFailureStage.SNAPSHOT, "snapshot_failed"],
  [ReportFailureStage.CSV_GENERATION, "csv_generation_failed"],
  [ReportFailureStage.REPORT_SIZE, "report_too_large"],
  [ReportFailureStage.EMAIL_SUBMISSION, "email_submission_failed"],
  [ReportFailureStage.UNEXPECTED, "unexpected_report_error"],
);
const generatedCaseArbitrary: fc.Arbitrary<GeneratedCase> = fc.record({
  ids: fc.tuple(fc.uuid(), fc.uuid(), fc.uuid(), fc.uuid(), fc.uuid())
    .filter((ids) => new Set(ids).size === ids.length),
  reportType: fc.constantFrom<"weekly" | "monthly">("weekly", "monthly"),
  referenceDate: referenceDateArbitrary,
  originalEmail: fc.string({ minLength: 1, maxLength: 24 }).map((value) => `${value}@old.test`),
  currentEmail: fc.string({ minLength: 1, maxLength: 24 }).map((value) => `${value}@new.test`),
  originalTimeZone: fc.constantFrom("UTC", "Asia/Kuala_Lumpur", "Pacific/Pago_Pago"),
  currentTimeZone: fc.constantFrom("UTC", "Asia/Kuala_Lumpur", "Pacific/Kiritimati"),
  progressStage: fc.constantFrom(
    "data_retrieval",
    "snapshot",
    "csv_generation",
    "email_submission",
    "delivery_wait",
  ),
  failure: failureArbitrary,
  createdAt: timestampArbitrary,
  updatedAt: timestampArbitrary,
  replayCount: fc.integer({ min: 1, max: 6 }),
});

function makeOriginal(input: GeneratedCase): PersistedRequest {
  const [originalId, userId, originalClientId] = input.ids;
  const resolver = new ReportPeriodResolver(clock);
  const resolved = resolver.resolve({
    reportType: input.reportType,
    referenceDate: input.referenceDate,
    timeZone: input.originalTimeZone,
  });
  return {
    id: originalId,
    userId,
    clientRequestId: originalClientId,
    retryOfId: null,
    reportType: input.reportType === "weekly" ? ReportType.WEEKLY : ReportType.MONTHLY,
    referenceDate: new Date(`${input.referenceDate}T00:00:00.000Z`),
    periodStart: new Date(`${resolved.period.startDate}T00:00:00.000Z`),
    periodEnd: new Date(`${resolved.period.endDate}T00:00:00.000Z`),
    accountEmail: input.originalEmail,
    timeZone: input.originalTimeZone,
    status: ReportStatus.FAILED,
    progressStage: input.progressStage,
    failureStage: input.failure[0],
    failureCode: input.failure[1],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    sentAt: null,
    delivery: null,
  };
}
describe("ReportRequestService immutable retries", () => {
  // Feature: bulk-csv-report-email, Property 23: Retry creates a new immutable attempt
  // **Validates: Requirements 7.8**
  it("creates one linked attempt, replays its idempotency key, and preserves every original field", async () => {
    await fc.assert(fc.asyncProperty(generatedCaseArbitrary, async (input) => {
      const [originalId, userId, , retryClientId, newRequestId] = input.ids;
      const original = makeOriginal(input);
      const before = persistedFields(original);
      const model = new TransactionalReportModel({
        id: userId,
        email: input.currentEmail,
        timeZone: input.currentTimeZone,
      }, original);
      const generatedIds = [newRequestId, input.ids[2]];
      const ids: IdGenerator = { generate: () => generatedIds.shift()! };
      const service = new ReportRequestService(
        model.prisma,
        new ReportPeriodResolver(clock),
        clock,
        ids,
      );

      const outcomes = [];
      for (let delivery = 0; delivery < input.replayCount; delivery += 1) {
        outcomes.push(await service.retry({
          userId,
          reportRequestId: originalId,
          clientRequestId: retryClientId,
        }));
      }

      const linkedAttempts = model.requests.filter((request) => request.retryOfId === originalId);
      expect(linkedAttempts).toHaveLength(1);
      expect(model.requests).toHaveLength(2);
      expect(linkedAttempts[0]).toMatchObject({
        id: newRequestId,
        userId,
        clientRequestId: retryClientId,
        retryOfId: originalId,
        reportType: original.reportType,
        accountEmail: input.currentEmail,
        timeZone: input.currentTimeZone,
        status: ReportStatus.PENDING,
      });
      expect(outcomes[0]).toMatchObject({ disposition: "created", request: { id: newRequestId } });
      for (const replay of outcomes.slice(1)) {
        expect(replay).toMatchObject({ disposition: "replayed", request: { id: newRequestId } });
      }
      expect(model.jobs).toHaveLength(1);
      expect(model.audits).toHaveLength(1);
      expect(persistedFields(model.request(originalId))).toEqual(before);
    }), { numRuns: 150 });
  });
});
