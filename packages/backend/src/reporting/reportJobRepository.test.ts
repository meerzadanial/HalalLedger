import { PrismaClient, ReportStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock, IdGenerator } from "./infrastructure";
import {
  PostgresReportJobRepository,
  type ReportJobLease,
} from "./reportJobRepository";

const NOW = new Date("2025-01-15T10:20:30.000Z");
const EXPIRY = new Date("2025-01-15T10:21:30.000Z");
const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";
const clock: Clock = { now: () => new Date(NOW) };
const ids: IdGenerator = { generate: () => JOB_ID };

function makeHarness(options: ConstructorParameters<typeof PostgresReportJobRepository>[3] = {}) {
  const tx = {
    reportJob: {
      upsert: vi.fn(),
      updateMany: vi.fn(),
      findFirst: vi.fn(),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  const prisma = {
    reportJob: tx.reportJob,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx)),
  };
  return {
    tx,
    prisma,
    repository: new PostgresReportJobRepository(
      prisma as unknown as PrismaClient,
      clock,
      ids,
      options,
    ),
  };
}

function lease(overrides: Partial<ReportJobLease> = {}): ReportJobLease {
  return {
    jobId: JOB_ID,
    workerId: "worker-a",
    leaseExpiresAt: EXPIRY,
    ...overrides,
  };
}

describe("PostgresReportJobRepository", () => {
  it("enqueues idempotently inside the caller transaction", async () => {
    const { repository, tx } = makeHarness();
    const persisted = { id: JOB_ID };
    tx.reportJob.upsert.mockResolvedValue(persisted);

    await expect(repository.enqueueInTransaction(tx as never, {
      reportRequestId: REQUEST_ID,
    })).resolves.toBe(persisted);

    expect(tx.reportJob.upsert).toHaveBeenCalledWith({
      where: { reportRequestId: REQUEST_ID },
      create: {
        id: JOB_ID,
        reportRequestId: REQUEST_ID,
        availableAt: NOW,
        maxAttempts: 8,
      },
      update: {},
    });
  });

  it("claims one eligible job with row locking, skip-locked, and a bounded lease", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.updateMany.mockResolvedValue({ count: 0 });
    tx.$queryRaw.mockResolvedValue([{
      id: JOB_ID,
      report_request_id: REQUEST_ID,
      available_at: NOW,
      lease_owner: "worker-a",
      lease_expires_at: EXPIRY,
      attempt_count: 2,
      max_attempts: 8,
      last_error_code: "provider_unavailable",
    }]);

    const claimed = await repository.claimNext({
      workerId: "worker-a",
      leaseDurationMs: 60_000,
    });

    expect(claimed).toEqual({
      jobId: JOB_ID,
      reportRequestId: REQUEST_ID,
      workerId: "worker-a",
      availableAt: NOW,
      leaseExpiresAt: EXPIRY,
      attemptCount: 2,
      maxAttempts: 8,
      lastErrorCode: "provider_unavailable",
    });
    const query = tx.$queryRaw.mock.calls[0][0] as { sql: string };
    expect(query.sql).toContain("FOR UPDATE OF job SKIP LOCKED");
    expect(query.sql).toContain('job."attempt_count" < job."max_attempts"');
    expect(query.sql).toContain('request."status" NOT IN');
  });

  it("returns no work after terminal jobs are settled", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });
    tx.$queryRaw.mockResolvedValue([]);

    await expect(repository.claimNext({
      workerId: "worker-a",
      leaseDurationMs: 60_000,
    })).resolves.toBeNull();

    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: {
        completedAt: null,
        reportRequest: {
          status: { in: [ReportStatus.SENT, ReportStatus.FAILED] },
        },
      },
      data: { completedAt: NOW, leaseOwner: null, leaseExpiresAt: null },
    });
  });

  it("heartbeats only the exact live lease token", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(repository.heartbeat(lease(), 120_000)).resolves.toEqual({
      jobId: JOB_ID,
      workerId: "worker-a",
      leaseExpiresAt: new Date("2025-01-15T10:22:30.000Z"),
    });
    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: JOB_ID,
        leaseOwner: "worker-a",
        leaseExpiresAt: { equals: EXPIRY, gt: NOW },
      }),
      data: { leaseExpiresAt: new Date("2025-01-15T10:22:30.000Z") },
    });
  });

  it("schedules exponential backoff and stores only an allowlisted error code", async () => {
    const { repository, tx } = makeHarness({
      initialBackoffMs: 1_000,
      maxBackoffMs: 10_000,
    });
    tx.reportJob.findFirst.mockResolvedValue({ attemptCount: 3, maxAttempts: 8 });
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(repository.scheduleRetry({
      lease: lease(),
      errorCode: "provider_unavailable",
    })).resolves.toEqual({
      disposition: "scheduled",
      availableAt: new Date("2025-01-15T10:20:34.000Z"),
    });
    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: JOB_ID, leaseOwner: "worker-a" }),
      data: {
        availableAt: new Date("2025-01-15T10:20:34.000Z"),
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "provider_unavailable",
      },
    });

    await expect(repository.scheduleRetry({
      lease: lease(),
      errorCode: "raw database password" as never,
    })).rejects.toThrow("stable report error code");
  });

  it("reports exhaustion without releasing the lease needed for terminal failure recording", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.findFirst.mockResolvedValue({ attemptCount: 8, maxAttempts: 8 });
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(repository.scheduleRetry({
      lease: lease(),
      errorCode: "unexpected_report_error",
    })).resolves.toEqual({ disposition: "exhausted" });
    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: JOB_ID }),
      data: { lastErrorCode: "unexpected_report_error" },
    });
  });

  it("completes only a current owned lease and otherwise no-ops", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(repository.complete({ lease: lease() })).resolves.toBe(true);
    await expect(repository.complete({ lease: lease() })).resolves.toBe(false);
    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: JOB_ID,
        leaseOwner: "worker-a",
        reportRequest: {
          is: { status: { notIn: [ReportStatus.SENT, ReportStatus.FAILED] } },
        },
      }),
      data: {
        completedAt: NOW,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: null,
      },
    });
  });

  it("reclaims expired retryable leases and identifies exhausted requests", async () => {
    const { repository, tx } = makeHarness();
    tx.reportJob.updateMany.mockResolvedValue({ count: 0 });
    tx.$queryRaw.mockResolvedValue([
      { report_request_id: "request-exhausted" },
    ]);
    tx.$executeRaw.mockResolvedValue(2);

    await expect(repository.reclaimExpiredLeases()).resolves.toEqual({
      reclaimedCount: 2,
      exhaustedReportRequestIds: ["request-exhausted"],
    });
    const reclaimSql = (tx.$executeRaw.mock.calls[0][0] as { sql: string }).sql;
    expect(reclaimSql).toContain('job."lease_expires_at" <=');
    expect(reclaimSql).toContain('job."attempt_count" < job."max_attempts"');
  });
});
