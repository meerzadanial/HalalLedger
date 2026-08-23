import { PrismaClient, ReportStatus, ReportType } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CreateReportRequestCommand } from "./commands";
import type { ReportProgressStage, ReportType as DomainReportType } from "./constants";
import { ReportInProgressError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { ReportPeriodResolver } from "./reportPeriodResolver";
import { ReportRequestService } from "./reportRequestService";
import type { ReportDateString } from "./temporal";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const NONTERMINAL_CASES = [
  [ReportStatus.PENDING, "data_retrieval"],
  [ReportStatus.PROCESSING, "snapshot"],
  [ReportStatus.EMAIL_SUBMITTED, "email_submission"],
  [ReportStatus.EMAIL_ACCEPTED, "delivery_wait"],
] as const satisfies readonly (readonly [ReportStatus, ReportProgressStage])[];

interface StoredUser {
  id: string;
  email: string;
  timeZone: string;
}

interface StoredRequest {
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
  progressStage: ReportProgressStage;
  failureStage: null;
  failureCode: null;
  createdAt: Date;
  updatedAt: Date;
  sentAt: null;
  delivery: null;
}

interface ModelState {
  users: StoredUser[];
  requests: StoredRequest[];
  jobs: Array<{ id: string; reportRequestId: string }>;
  audits: Array<{ userId: string; entityId: string }>;
}
class TransactionalReportModel {
  private state: ModelState;

  constructor(users: StoredUser[]) {
    this.state = { users, requests: [], jobs: [], audits: [] };
  }

  readonly prisma = {
    $transaction: async <T>(operation: (tx: unknown) => Promise<T>): Promise<T> => {
      const draft = cloneState(this.state);
      const result = await operation(this.clientFor(draft));
      this.state = draft;
      return result;
    },
    user: this.userClient(() => this.state),
    reportRequest: this.requestClient(() => this.state),
    reportJob: this.jobClient(() => this.state),
    auditLog: this.auditClient(() => this.state),
  };

  requestsFor(userId: string): StoredRequest[] {
    return this.state.requests.filter((request) => request.userId === userId);
  }

  setNonterminalState(
    userId: string,
    status: ReportStatus,
    progressStage: ReportProgressStage,
  ): void {
    const request = this.requestsFor(userId)[0];
    request.status = status;
    request.progressStage = progressStage;
  }

  jobCount(): number {
    return this.state.jobs.length;
  }

  auditCount(): number {
    return this.state.audits.length;
  }

  private clientFor(state: ModelState) {
    return {
      user: this.userClient(() => state),
      reportRequest: this.requestClient(() => state),
      reportJob: this.jobClient(() => state),
      auditLog: this.auditClient(() => state),
    };
  }

  private userClient(state: () => ModelState) {
    return {
      findUnique: async ({ where }: { where: { id: string } }) =>
        state().users.find((user) => user.id === where.id) ?? null,
    };
  }

  private requestClient(state: () => ModelState) {
    return {
      findUnique: async ({ where }: { where: {
        userId_clientRequestId: { userId: string; clientRequestId: string };
      } }) => state().requests.find((request) =>
        request.userId === where.userId_clientRequestId.userId &&
        request.clientRequestId === where.userId_clientRequestId.clientRequestId
      ) ?? null,
      findFirst: async ({ where }: { where: {
        userId: string;
        status: { notIn: ReportStatus[] };
      } }) => state().requests.find((request) =>
        request.userId === where.userId && !where.status.notIn.includes(request.status)
      ) ?? null,
      create: async ({ data }: { data: Omit<StoredRequest,
        "failureStage" | "failureCode" | "createdAt" | "updatedAt" | "sentAt" | "delivery"
      > }) => {
        if (state().requests.some((request) =>
          request.userId === data.userId &&
          request.clientRequestId === data.clientRequestId
        )) throw new Error("transactional model: duplicate idempotency key");
        if (state().requests.some((request) =>
          request.userId === data.userId &&
          request.status !== ReportStatus.SENT &&
          request.status !== ReportStatus.FAILED
        )) throw new Error("transactional model: duplicate active request");
        const request: StoredRequest = {
          ...data,
          failureStage: null,
          failureCode: null,
          createdAt: new Date(NOW),
          updatedAt: new Date(NOW),
          sentAt: null,
          delivery: null,
        };
        state().requests.push(request);
        return request;
      },
    };
  }
  private jobClient(state: () => ModelState) {
    return {
      upsert: async ({ where, create }: {
        where: { reportRequestId: string };
        create: { id: string; reportRequestId: string };
      }) => {
        const existing = state().jobs.find((job) =>
          job.reportRequestId === where.reportRequestId
        );
        if (existing) return existing;
        const job = { id: create.id, reportRequestId: create.reportRequestId };
        state().jobs.push(job);
        return job;
      },
    };
  }

  private auditClient(state: () => ModelState) {
    return {
      create: async ({ data }: { data: { userId: string; entityId: string } }) => {
        const audit = { userId: data.userId, entityId: data.entityId };
        state().audits.push(audit);
        return audit;
      },
    };
  }
}

function cloneState(state: ModelState): ModelState {
  return {
    users: state.users.map((user) => ({ ...user })),
    requests: state.requests.map((request) => ({
      ...request,
      referenceDate: new Date(request.referenceDate),
      periodStart: new Date(request.periodStart),
      periodEnd: new Date(request.periodEnd),
      createdAt: new Date(request.createdAt),
      updatedAt: new Date(request.updatedAt),
    })),
    jobs: state.jobs.map((job) => ({ ...job })),
    audits: state.audits.map((audit) => ({ ...audit })),
  };
}

function uuidFrom(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function dateFromOffset(offset: number): ReportDateString {
  const date = new Date(Date.UTC(2020, 0, 1 + offset));
  return date.toISOString().slice(0, 10) as ReportDateString;
}

const commandCaseArbitrary = fc.record({
  duplicateDeliveries: fc.integer({ min: 1, max: 8 }),
  primaryType: fc.constantFrom<DomainReportType>("weekly", "monthly"),
  competingType: fc.constantFrom<DomainReportType>("weekly", "monthly"),
  primaryDateOffset: fc.integer({ min: 0, max: 2_000 }),
  competingDateOffset: fc.integer({ min: 0, max: 2_000 }),
  timeZone: fc.constantFrom("UTC", "Asia/Kuala_Lumpur", "Pacific/Auckland"),
  nonterminal: fc.constantFrom(...NONTERMINAL_CASES),
});

const clock: Clock = { now: () => new Date(NOW) };

describe("ReportRequestService idempotent creation and active request", () => {
  // Feature: bulk-csv-report-email, Property 1: Idempotent creation and one active request
  // **Validates: Requirements 1.6, 1.7**
  it("creates one server-derived request per user under duplicate and competing deliveries", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(commandCaseArbitrary, { minLength: 1, maxLength: 5 }),
      async (cases) => {
        const users = cases.map((item, index) => ({
          id: `user-${index}`,
          email: `driver-${index}@example.com`,
          timeZone: item.timeZone,
        }));
        const model = new TransactionalReportModel(users);
        let nextId = 10_000;
        const ids: IdGenerator = { generate: () => uuidFrom(nextId++) };
        const service = new ReportRequestService(
          model.prisma as unknown as PrismaClient,
          new ReportPeriodResolver(clock),
          clock,
          ids,
        );

        for (const [index, item] of cases.entries()) {
          const user = users[index];
          const primary: CreateReportRequestCommand = {
            userId: user.id,
            reportType: item.primaryType,
            referenceDate: dateFromOffset(item.primaryDateOffset),
            clientRequestId: uuidFrom(index * 2 + 1),
          };
          const competing: CreateReportRequestCommand = {
            userId: user.id,
            reportType: item.competingType,
            referenceDate: dateFromOffset(item.competingDateOffset),
            clientRequestId: uuidFrom(index * 2 + 2),
          };

          const first = await service.create(primary);
          expect(first.disposition).toBe("created");
          model.setNonterminalState(user.id, ...item.nonterminal);
          for (let delivery = 1; delivery < item.duplicateDeliveries; delivery++) {
            const replay = await service.create(primary);
            expect(replay).toMatchObject({
              disposition: "replayed",
              request: { id: first.request.id, accountEmail: user.email },
            });
          }

          let blocked: unknown;
          try {
            await service.create(competing);
          } catch (error) {
            blocked = error;
          }
          expect(blocked).toBeInstanceOf(ReportInProgressError);
          expect(blocked).toMatchObject({
            code: "report_in_progress",
            activeRequest: { id: first.request.id, status: item.nonterminal[0].toLowerCase() },
          });

          const persisted = model.requestsFor(user.id);
          expect(persisted).toHaveLength(1);
          expect(persisted[0]).toMatchObject({
            userId: user.id,
            clientRequestId: primary.clientRequestId,
            reportType: primary.reportType === "weekly" ? ReportType.WEEKLY : ReportType.MONTHLY,
            accountEmail: user.email,
            status: item.nonterminal[0],
          });
          expect(persisted[0].referenceDate.toISOString().slice(0, 10))
            .toBe(primary.referenceDate);
        }

        expect(model.jobCount()).toBe(cases.length);
        expect(model.auditCount()).toBe(cases.length);
      },
    ), { numRuns: 200 });
  });
});
