import {
  Prisma,
  PrismaClient,
  ReportStatus as DbReportStatus,
  type ReportJob,
} from "@prisma/client";
import { REPORT_ERROR_CODES, type ReportErrorCode } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { RandomUuidGenerator } from "./infrastructure";

const TERMINAL_STATUSES = [
  DbReportStatus.SENT,
  DbReportStatus.FAILED,
] as const;

export interface EnqueueReportJobInput {
  readonly reportRequestId: string;
  readonly availableAt?: Date;
  readonly maxAttempts?: number;
  readonly id?: string;
}

export interface ReportJobLease {
  readonly jobId: string;
  readonly workerId: string;
  readonly leaseExpiresAt: Date;
}

export interface ClaimedReportJob extends ReportJobLease {
  readonly reportRequestId: string;
  readonly availableAt: Date;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly lastErrorCode: ReportErrorCode | null;
}

export interface ClaimReportJobInput {
  readonly workerId: string;
  readonly leaseDurationMs: number;
}

export interface RetryReportJobInput {
  readonly lease: ReportJobLease;
  readonly errorCode: ReportErrorCode;
}

export interface CompleteReportJobInput {
  readonly lease: ReportJobLease;
  readonly errorCode?: ReportErrorCode | null;
}

export type RetryReportJobResult =
  | { readonly disposition: "scheduled"; readonly availableAt: Date }
  | { readonly disposition: "exhausted" }
  | { readonly disposition: "stale" };

export interface ReclaimExpiredLeasesResult {
  readonly reclaimedCount: number;
  readonly exhaustedReportRequestIds: readonly string[];
}

export interface ReportJobRepositoryOptions {
  readonly defaultMaxAttempts?: number;
  readonly initialBackoffMs?: number;
  readonly maxBackoffMs?: number;
}

type Transaction = Prisma.TransactionClient;

type RawClaimedJob = {
  id: string;
  report_request_id: string;
  available_at: Date;
  lease_owner: string;
  lease_expires_at: Date;
  attempt_count: number;
  max_attempts: number;
  last_error_code: string | null;
};

type RawExhaustedJob = { report_request_id: string };

/** PostgreSQL-backed durable outbox with cooperative, expiring leases. */
export class PostgresReportJobRepository {
  private readonly ids: IdGenerator;
  private readonly defaultMaxAttempts: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock,
    ids?: IdGenerator,
    options: ReportJobRepositoryOptions = {},
  ) {
    this.ids = ids ?? new RandomUuidGenerator();
    this.defaultMaxAttempts = positiveInteger(
      options.defaultMaxAttempts ?? 8,
      "defaultMaxAttempts",
    );
    this.initialBackoffMs = positiveInteger(
      options.initialBackoffMs ?? 1_000,
      "initialBackoffMs",
    );
    this.maxBackoffMs = positiveInteger(
      options.maxBackoffMs ?? 300_000,
      "maxBackoffMs",
    );
    if (this.initialBackoffMs > this.maxBackoffMs) {
      throw new TypeError("initialBackoffMs cannot exceed maxBackoffMs");
    }
  }

  async enqueue(input: EnqueueReportJobInput): Promise<ReportJob> {
    return this.prisma.$transaction((tx) => this.enqueueInTransaction(tx, input));
  }

  async enqueueInTransaction(
    tx: Transaction,
    input: EnqueueReportJobInput,
  ): Promise<ReportJob> {
    const maxAttempts = positiveInteger(
      input.maxAttempts ?? this.defaultMaxAttempts,
      "maxAttempts",
    );
    return tx.reportJob.upsert({
      where: { reportRequestId: input.reportRequestId },
      create: {
        id: input.id ?? this.ids.generate(),
        reportRequestId: input.reportRequestId,
        availableAt: copyDate(input.availableAt ?? this.clock.now()),
        maxAttempts,
      },
      update: {},
    });
  }

  async claimNext(input: ClaimReportJobInput): Promise<ClaimedReportJob | null> {
    const workerId = nonBlank(input.workerId, "workerId");
    const leaseDurationMs = positiveInteger(
      input.leaseDurationMs,
      "leaseDurationMs",
    );
    const now = this.clock.now();
    const leaseExpiresAt = addMilliseconds(now, leaseDurationMs);

    return this.prisma.$transaction(async (tx) => {
      await settleTerminalJobs(tx, now);
      const rows = await tx.$queryRaw<RawClaimedJob[]>(Prisma.sql`
        WITH candidate AS (
          SELECT job."id"
          FROM "report_jobs" AS job
          INNER JOIN "report_requests" AS request
            ON request."id" = job."report_request_id"
          WHERE job."completed_at" IS NULL
            AND job."available_at" <= ${now}
            AND job."attempt_count" < job."max_attempts"
            AND (
              job."lease_owner" IS NULL
              OR job."lease_expires_at" <= ${now}
            )
            AND request."status" NOT IN (
              CAST('SENT' AS "ReportStatus"),
              CAST('FAILED' AS "ReportStatus")
            )
          ORDER BY job."available_at" ASC, job."created_at" ASC, job."id" ASC
          FOR UPDATE OF job SKIP LOCKED
          LIMIT 1
        )
        UPDATE "report_jobs" AS job
        SET "lease_owner" = ${workerId},
            "lease_expires_at" = ${leaseExpiresAt},
            "attempt_count" = job."attempt_count" + 1,
            "updated_at" = ${now}
        FROM candidate
        WHERE job."id" = candidate."id"
        RETURNING job."id", job."report_request_id", job."available_at",
                  job."lease_owner", job."lease_expires_at", job."attempt_count",
                  job."max_attempts", job."last_error_code"
      `);
      return rows.length === 0 ? null : mapClaim(rows[0]);
    });
  }

  async heartbeat(
    lease: ReportJobLease,
    leaseDurationMs: number,
  ): Promise<ReportJobLease | null> {
    validateLease(lease);
    const duration = positiveInteger(leaseDurationMs, "leaseDurationMs");
    const now = this.clock.now();
    const leaseExpiresAt = addMilliseconds(now, duration);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reportJob.updateMany({
        where: activeLeaseWhere(lease, now),
        data: { leaseExpiresAt },
      });
      if (updated.count === 0) return null;
      return { jobId: lease.jobId, workerId: lease.workerId, leaseExpiresAt };
    });
  }

  async scheduleRetry(input: RetryReportJobInput): Promise<RetryReportJobResult> {
    validateLease(input.lease);
    const errorCode = safeErrorCode(input.errorCode);
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const job = await tx.reportJob.findFirst({
        where: activeLeaseWhere(input.lease, now),
        select: { attemptCount: true, maxAttempts: true },
      });
      if (job === null) return { disposition: "stale" };

      if (job.attemptCount >= job.maxAttempts) {
        const recorded = await tx.reportJob.updateMany({
          where: activeLeaseWhere(input.lease, now),
          data: { lastErrorCode: errorCode },
        });
        return recorded.count === 0
          ? { disposition: "stale" }
          : { disposition: "exhausted" };
      }

      const availableAt = addMilliseconds(
        now,
        exponentialBackoff(
          job.attemptCount,
          this.initialBackoffMs,
          this.maxBackoffMs,
        ),
      );
      const released = await tx.reportJob.updateMany({
        where: activeLeaseWhere(input.lease, now),
        data: {
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastErrorCode: errorCode,
        },
      });
      return released.count === 0
        ? { disposition: "stale" }
        : { disposition: "scheduled", availableAt };
    });
  }

  async complete(input: CompleteReportJobInput): Promise<boolean> {
    validateLease(input.lease);
    const errorCode = input.errorCode == null
      ? null
      : safeErrorCode(input.errorCode);
    const now = this.clock.now();
    const result = await this.prisma.reportJob.updateMany({
      where: activeLeaseWhere(input.lease, now),
      data: {
        completedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: errorCode,
      },
    });
    return result.count === 1;
  }

  async reclaimExpiredLeases(): Promise<ReclaimExpiredLeasesResult> {
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      await settleTerminalJobs(tx, now);
      const exhausted = await tx.$queryRaw<RawExhaustedJob[]>(Prisma.sql`
        SELECT job."report_request_id"
        FROM "report_jobs" AS job
        INNER JOIN "report_requests" AS request
          ON request."id" = job."report_request_id"
        WHERE job."completed_at" IS NULL
          AND job."lease_expires_at" <= ${now}
          AND job."attempt_count" >= job."max_attempts"
          AND request."status" NOT IN (
            CAST('SENT' AS "ReportStatus"),
            CAST('FAILED' AS "ReportStatus")
          )
        FOR UPDATE OF job SKIP LOCKED
      `);
      const reclaimedCount = await tx.$executeRaw(Prisma.sql`
        UPDATE "report_jobs" AS job
        SET "lease_owner" = NULL,
            "lease_expires_at" = NULL,
            "updated_at" = ${now}
        FROM "report_requests" AS request
        WHERE request."id" = job."report_request_id"
          AND job."completed_at" IS NULL
          AND job."lease_expires_at" <= ${now}
          AND job."attempt_count" < job."max_attempts"
          AND request."status" NOT IN (
            CAST('SENT' AS "ReportStatus"),
            CAST('FAILED' AS "ReportStatus")
          )
      `);
      return {
        reclaimedCount,
        exhaustedReportRequestIds: exhausted.map((row) => row.report_request_id),
      };
    });
  }
}

function activeLeaseWhere(
  lease: ReportJobLease,
  now: Date,
): Prisma.ReportJobWhereInput {
  return {
    id: lease.jobId,
    completedAt: null,
    leaseOwner: lease.workerId,
    leaseExpiresAt: { equals: lease.leaseExpiresAt, gt: now },
    reportRequest: {
      is: { status: { notIn: [...TERMINAL_STATUSES] } },
    },
  };
}

async function settleTerminalJobs(tx: Transaction, now: Date): Promise<void> {
  await tx.reportJob.updateMany({
    where: {
      completedAt: null,
      reportRequest: { status: { in: [...TERMINAL_STATUSES] } },
    },
    data: { completedAt: now, leaseOwner: null, leaseExpiresAt: null },
  });
}

function mapClaim(row: RawClaimedJob): ClaimedReportJob {
  return {
    jobId: row.id,
    reportRequestId: row.report_request_id,
    workerId: row.lease_owner,
    availableAt: copyDate(row.available_at),
    leaseExpiresAt: copyDate(row.lease_expires_at),
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    lastErrorCode: row.last_error_code === null
      ? null
      : safeErrorCode(row.last_error_code),
  };
}

function exponentialBackoff(
  attemptCount: number,
  initialBackoffMs: number,
  maxBackoffMs: number,
): number {
  const exponent = Math.max(0, attemptCount - 1);
  return Math.min(maxBackoffMs, initialBackoffMs * 2 ** Math.min(exponent, 52));
}

function validateLease(lease: ReportJobLease): void {
  nonBlank(lease.jobId, "lease.jobId");
  nonBlank(lease.workerId, "lease.workerId");
  if (!(lease.leaseExpiresAt instanceof Date) || Number.isNaN(lease.leaseExpiresAt.valueOf())) {
    throw new TypeError("lease.leaseExpiresAt must be a valid Date");
  }
}

function safeErrorCode(value: string): ReportErrorCode {
  if (!REPORT_ERROR_CODES.includes(value as ReportErrorCode)) {
    throw new TypeError("last error code must be a stable report error code");
  }
  return value as ReportErrorCode;
}

function nonBlank(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be non-blank`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  const result = new Date(date.valueOf() + milliseconds);
  if (Number.isNaN(result.valueOf())) {
    throw new RangeError("calculated job timestamp is outside the Date range");
  }
  return result;
}

function copyDate(value: Date): Date {
  return new Date(value.valueOf());
}
