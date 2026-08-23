import {
  Prisma,
  PrismaClient,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CsvReportGenerator } from "./csvReportGenerator";
import type { Clock, IdGenerator } from "./infrastructure";
import type { ReportDataService } from "./reportDataService";
import { ReportEmailService } from "./reportEmailService";
import type {
  ClaimedReportJob,
  PostgresReportJobRepository,
  ReportJobLease,
} from "./reportJobRepository";
import type { ReportRequestService } from "./reportRequestService";
import {
  EmailProviderSubmissionError,
  type EmailProvider,
  type EmailProviderCommand,
} from "./provider";
import { ReportWorker } from "./reportWorker";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const DELIVERY_ID = "33333333-3333-4333-8333-333333333333";
const START = new Date("2025-01-15T10:20:30.000Z");
const LEASE_MS = 25;
const EXPECTED_KEY = `report:${REQUEST_ID}`;

type CrashPoint =
  | "after_csv_before_claim"
  | "after_claim_before_submission"
  | "after_acceptance_before_ack";

type StoredDelivery = {
  id: string;
  reportRequestId: string;
  idempotencyKey: string;
  providerMessageId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  deliveryDeadlineAt: Date | null;
  confirmedAt: Date | null;
};
type DurableRequest = ReturnType<typeof requestFixture>;

function requestFixture() {
  return {
    id: REQUEST_ID,
    userId: "user-1",
    accountEmail: "persisted@example.com",
    reportType: ReportType.WEEKLY,
    periodStart: new Date("2025-01-06T00:00:00.000Z"),
    periodEnd: new Date("2025-01-12T00:00:00.000Z"),
    status: ReportStatus.PROCESSING as ReportStatus,
    progressStage: "email_submission",
    sentAt: null as Date | null,
    snapshot: {
      id: "snapshot-1",
      recordCount: 1,
      digitalIncomeTotal: new Prisma.Decimal("10.00"),
      cashIncomeTotal: new Prisma.Decimal("0.00"),
      halalIncomeTotal: new Prisma.Decimal("10.00"),
      nonHalalIncomeTotal: new Prisma.Decimal("0.00"),
    },
    attachment: {
      id: "attachment-1",
      content: Buffer.from("persisted,csv\r\n", "utf8"),
      byteSize: Buffer.byteLength("persisted,csv\r\n", "utf8"),
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: "text/csv; charset=UTF-8",
    },
  };
}

/** Transactional model of the unique request, attachment, and delivery rows. */
class DurableReportModel {
  readonly request: DurableRequest = requestFixture();
  readonly deliveries: StoredDelivery[] = [];
  private transactionTail: Promise<void> = Promise.resolve();

  readonly prisma = {
    $transaction: <T>(operation: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = this.transactionTail.then(() => operation(this.transactionClient()));
      this.transactionTail = run.then(() => undefined, () => undefined);
      return run;
    },
    reportRequest: {
      findUnique: async (_args?: unknown) => this.readRequest(),
    },
    reportAttachment: {
      create: async () => {
        throw new Error("immutable attachment already exists");
      },
    },
  } as any;

  constructor() {}

  readRequest() {
    return {
      ...this.request,
      snapshot: { ...this.request.snapshot },
      attachment: {
        ...this.request.attachment,
        content: Buffer.from(this.request.attachment.content),
      },
      delivery: this.deliveries[0] ?? null,
    };
  }

  readonly requestService = {
    transitionNonterminal: async (input: any) => {
      const from = input.fromStatuses.map(toDbStatus);
      if (!from.includes(this.request.status)) return null;
      this.request.status = toDbStatus(input.toStatus);
      this.request.progressStage = input.progressStage;
      return { status: input.toStatus };
    },
    recordFailure: async ({ failure }: any) => {
      this.request.status = ReportStatus.FAILED;
      return { status: "failed", failure: failure.toPublicFailure() };
    },
  };

  private transactionClient() {
    return {
      reportRequest: {
        findUnique: async () => this.readRequest(),
        updateMany: async ({ where, data }: any) => {
          if (where.id !== REQUEST_ID || where.status !== this.request.status) {
            return { count: 0 };
          }
          Object.assign(this.request, data);
          return { count: 1 };
        },
      },
      reportDelivery: {
        create: async ({ data }: any) => {
          if (this.deliveries.length !== 0) {
            throw new Error("unique report_request_id violation");
          }
          const delivery: StoredDelivery = {
            ...data,
            providerMessageId: null,
            acceptedAt: null,
            confirmedAt: null,
          };
          this.deliveries.push(delivery);
          return delivery;
        },
        update: async ({ data }: any) => {
          const delivery = this.deliveries[0];
          if (!delivery) throw new Error("missing delivery");
          Object.assign(delivery, data);
          return delivery;
        },
        updateMany: async ({ where, data }: any) => {
          const delivery = this.deliveries[0];
          if (
            !delivery ||
            where.reportRequestId !== REQUEST_ID ||
            (where.acceptedAt === null && delivery.acceptedAt !== null)
          ) {
            return { count: 0 };
          }
          Object.assign(delivery, data);
          return { count: 1 };
        },
        findUnique: async () => this.deliveries[0] ?? null,
      },
    };
  }
}

function toDbStatus(status: string): ReportStatus {
  const statuses: Record<string, ReportStatus> = {
    pending: ReportStatus.PENDING,
    processing: ReportStatus.PROCESSING,
    email_submitted: ReportStatus.EMAIL_SUBMITTED,
    email_accepted: ReportStatus.EMAIL_ACCEPTED,
    sent: ReportStatus.SENT,
    failed: ReportStatus.FAILED,
  };
  const result = statuses[status];
  if (!result) throw new Error(`unsupported status ${status}`);
  return result;
}

class MutableClock implements Clock {
  private current = START.getTime();

  now(): Date {
    return new Date(this.current);
  }

  advanceBy(milliseconds: number): void {
    this.current += milliseconds;
  }

  advanceTo(value: Date): void {
    this.current = Math.max(this.current, value.getTime());
  }
}

/** Faithful single-job lease model with expiry, reclaim, and durable backoff. */
class DurableJobModel {
  private availableAt = new Date(START);
  private leaseOwner: string | null = null;
  private leaseExpiresAt: Date | null = null;
  private attemptCount = 0;
  private completed = false;
  private retryIndex = 0;
  reclaimedCount = 0;

  constructor(
    private readonly clock: MutableClock,
    private expireOnHeartbeat: number,
    private failCompletionAfterAcceptance: number,
    private readonly retryScheduleMs: readonly number[],
  ) {}

  claimForCrashedProcess(): void {
    if (this.claim("crashed-worker") === null) {
      throw new Error("expected initial crash claim");
    }
  }

  reclaimExpiredLeases(): number {
    if (
      this.leaseOwner !== null &&
      this.leaseExpiresAt !== null &&
      this.leaseExpiresAt.getTime() <= this.clock.now().getTime()
    ) {
      this.leaseOwner = null;
      this.leaseExpiresAt = null;
      this.reclaimedCount += 1;
      return 1;
    }
    return 0;
  }

  readonly repository = {
    claimNext: async ({ workerId }: { workerId: string }) => this.claim(workerId),
    heartbeat: async (lease: ReportJobLease, duration: number) => {
      if (!this.active(lease)) return null;
      if (this.expireOnHeartbeat > 0) {
        this.expireOnHeartbeat -= 1;
        this.clock.advanceTo(new Date(lease.leaseExpiresAt.getTime() + 1));
        return null;
      }
      const renewed = {
        ...lease,
        leaseExpiresAt: new Date(this.clock.now().getTime() + duration),
      };
      this.leaseExpiresAt = renewed.leaseExpiresAt;
      return renewed;
    },
    scheduleRetry: async ({ lease }: { lease: ReportJobLease }) => {
      if (!this.active(lease)) return { disposition: "stale" as const };
      const delay = this.retryScheduleMs[
        this.retryIndex % this.retryScheduleMs.length
      ];
      this.retryIndex += 1;
      this.availableAt = new Date(this.clock.now().getTime() + delay);
      this.leaseOwner = null;
      this.leaseExpiresAt = null;
      return { disposition: "scheduled" as const, availableAt: this.availableAt };
    },
    complete: async ({ lease }: { lease: ReportJobLease }) => {
      if (!this.active(lease)) return false;
      if (this.failCompletionAfterAcceptance > 0) {
        this.failCompletionAfterAcceptance -= 1;
        this.clock.advanceTo(new Date(lease.leaseExpiresAt.getTime() + 1));
        return false;
      }
      this.completed = true;
      this.leaseOwner = null;
      this.leaseExpiresAt = null;
      return true;
    },
  };

  get isCompleted(): boolean {
    return this.completed;
  }

  private claim(workerId: string): ClaimedReportJob | null {
    const now = this.clock.now();
    if (
      this.completed ||
      this.availableAt.getTime() > now.getTime() ||
      (this.leaseOwner !== null &&
        this.leaseExpiresAt !== null &&
        this.leaseExpiresAt.getTime() > now.getTime())
    ) {
      return null;
    }
    this.attemptCount += 1;
    this.leaseOwner = workerId;
    this.leaseExpiresAt = new Date(now.getTime() + LEASE_MS);
    return {
      jobId: JOB_ID,
      reportRequestId: REQUEST_ID,
      workerId,
      availableAt: new Date(this.availableAt),
      leaseExpiresAt: new Date(this.leaseExpiresAt),
      attemptCount: this.attemptCount,
      maxAttempts: 64,
      lastErrorCode: null,
    };
  }

  private active(lease: ReportJobLease): boolean {
    return !this.completed &&
      this.leaseOwner === lease.workerId &&
      this.leaseExpiresAt?.getTime() === lease.leaseExpiresAt.getTime() &&
      lease.leaseExpiresAt.getTime() > this.clock.now().getTime();
  }
}

/** Provider stores by idempotency key before ambiguous responses are lost. */
class IdempotentAmbiguousProvider implements EmailProvider {
  readonly commands: EmailProviderCommand[] = [];
  readonly logicalMessages = new Map<string, string>();

  constructor(
    private ambiguousResponsesRemaining: number,
    private readonly clock: MutableClock,
  ) {}

  async submit(command: EmailProviderCommand) {
    this.commands.push(command);
    const providerMessageId = this.logicalMessages.get(command.idempotencyKey)
      ?? `provider-message-${this.logicalMessages.size + 1}`;
    this.logicalMessages.set(command.idempotencyKey, providerMessageId);

    if (this.ambiguousResponsesRemaining > 0) {
      this.ambiguousResponsesRemaining -= 1;
      throw new EmailProviderSubmissionError("unavailable");
    }
    return { providerMessageId, acceptedAt: this.clock.now() };
  }

  verifyWebhook(): never {
    throw new Error("not used");
  }
}

function makeWorker(
  sequence: number,
  model: DurableReportModel,
  jobs: DurableJobModel,
  email: ReportEmailService,
  clock: MutableClock,
): ReportWorker {
  const data = {
    readSnapshot: async () => {
      throw new Error("persisted attachment must prevent snapshot reads");
    },
    createSnapshot: async () => {
      throw new Error("persisted attachment must prevent source queries");
    },
  };
  const csv = {
    generate: () => {
      throw new Error("persisted attachment must never be regenerated");
    },
  };
  const ids: IdGenerator = { generate: () => DELIVERY_ID };
  return new ReportWorker(
    model.prisma as PrismaClient,
    jobs.repository as unknown as PostgresReportJobRepository,
    model.requestService as unknown as ReportRequestService,
    data as unknown as ReportDataService,
    csv as unknown as CsvReportGenerator,
    email,
    {
      workerId: `worker-${sequence}`,
      leaseDurationMs: LEASE_MS,
      attachmentLimitBytes: 1_024,
      clock,
    },
    ids,
  );
}

const scenarioArbitrary = fc.record({
  crashPoints: fc.array(fc.constantFrom<CrashPoint>(
    "after_csv_before_claim",
    "after_claim_before_submission",
    "after_acceptance_before_ack",
  ), { minLength: 1, maxLength: 6 }),
  leaseExpiryAdvanceMs: fc.integer({ min: 1, max: 50 }),
  ambiguousResponses: fc.integer({ min: 1, max: 3 }),
  retryScheduleMs: fc.array(fc.integer({ min: 1, max: 20 }), {
    minLength: 1,
    maxLength: 5,
  }),
});

describe("ReportWorker logical submission retries", () => {
  // Feature: bulk-csv-report-email, Property 19: Submission retries represent one logical email
  // **Validates: Requirements 6.12**
  it("preserves one delivery identity across crashes, reclaimed leases, ambiguity, and backoff", async () => {
    await fc.assert(fc.asyncProperty(scenarioArbitrary, async (scenario) => {
      const clock = new MutableClock();
      const model = new DurableReportModel();
      const afterClaimCrashes = scenario.crashPoints.filter(
        (point) => point === "after_claim_before_submission",
      ).length;
      const afterAcceptanceCrashes = scenario.crashPoints.filter(
        (point) => point === "after_acceptance_before_ack",
      ).length;
      const jobs = new DurableJobModel(
        clock,
        afterClaimCrashes,
        afterAcceptanceCrashes,
        scenario.retryScheduleMs,
      );
      const provider = new IdempotentAmbiguousProvider(
        scenario.ambiguousResponses,
        clock,
      );
      const email = new ReportEmailService(
        model.prisma as PrismaClient,
        provider,
        clock,
        model.requestService,
        { generate: () => DELIVERY_ID },
      );

      for (const point of scenario.crashPoints) {
        if (point === "after_csv_before_claim") {
          makeWorker(-1, model, jobs, email, clock);
        }
      }

      jobs.claimForCrashedProcess();
      clock.advanceBy(LEASE_MS + scenario.leaseExpiryAdvanceMs);
      expect(jobs.reclaimExpiredLeases()).toBe(1);

      for (let restart = 0; restart < 64 && !jobs.isCompleted; restart += 1) {
        const worker = makeWorker(restart, model, jobs, email, clock);
        const result = await worker.runOnce();
        if (result.disposition === "retry_scheduled") {
          clock.advanceTo(result.availableAt);
        } else if (result.disposition === "stale") {
          expect(jobs.reclaimExpiredLeases()).toBe(1);
        } else if (result.disposition === "idle") {
          throw new Error("durable job unexpectedly became unavailable");
        }
      }

      expect(jobs.isCompleted).toBe(true);
      expect(jobs.reclaimedCount).toBe(
        1 + afterClaimCrashes + afterAcceptanceCrashes,
      );
      expect(model.request.status).toBe(ReportStatus.EMAIL_ACCEPTED);
      expect(model.deliveries).toHaveLength(1);
      expect(model.deliveries[0]).toMatchObject({
        reportRequestId: REQUEST_ID,
        idempotencyKey: EXPECTED_KEY,
        providerMessageId: "provider-message-1",
      });
      expect(model.deliveries[0].acceptedAt).not.toBeNull();
      expect(provider.commands).toHaveLength(scenario.ambiguousResponses + 1);
      expect(new Set(provider.commands.map((command) => command.idempotencyKey)))
        .toEqual(new Set([EXPECTED_KEY]));
      expect(provider.logicalMessages).toEqual(
        new Map([[EXPECTED_KEY, "provider-message-1"]]),
      );
    }), { numRuns: 120 });
  });
});
