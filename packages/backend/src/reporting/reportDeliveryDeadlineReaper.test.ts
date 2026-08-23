import { PrismaClient, ReportStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import { ReportDeliveryDeadlineReaper } from "./reportDeliveryDeadlineReaper";

const NOW = new Date("2025-01-15T10:05:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };

const submitted = {
  id: "request-submitted",
  user_id: "user-1",
  status_from: ReportStatus.EMAIL_SUBMITTED,
};
const accepted = {
  id: "request-accepted",
  user_id: "user-2",
  status_from: ReportStatus.EMAIL_ACCEPTED,
};

function makeHarness(rows: readonly (typeof submitted | typeof accepted)[] = []) {
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([...rows]),
    reportJob: { updateMany: vi.fn().mockResolvedValue({ count: rows.length }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx)),
  };
  return {
    tx,
    prisma,
    reaper: new ReportDeliveryDeadlineReaper(
      prisma as unknown as PrismaClient,
      clock,
      { batchSize: 25 },
    ),
  };
}

describe("ReportDeliveryDeadlineReaper", () => {
  it("fails submitted and accepted requests at the inclusive deadline", async () => {
    const { reaper, tx } = makeHarness([submitted, accepted]);

    await expect(reaper.sweep()).resolves.toEqual({
      timedOutCount: 2,
      reportRequestIds: [submitted.id, accepted.id],
    });

    const query = tx.$queryRaw.mock.calls[0][0] as {
      sql: string;
      values: unknown[];
    };
    expect(query.sql).toContain('delivery."delivery_deadline_at" <=');
    expect(query.sql).toContain('delivery."confirmed_at" IS NULL');
    expect(query.sql).toContain("FOR UPDATE OF request, delivery SKIP LOCKED");
    expect(query.sql).toContain("request.\"status\" IN");
    expect(query.values.filter((value) => value instanceof Date)).toEqual([
      NOW,
      NOW,
      NOW,
    ]);
    expect(query.values).toContain(25);
  });
  it("completes jobs and records one terminal audit per timed-out request", async () => {
    const { reaper, tx } = makeHarness([submitted, accepted]);

    await reaper.sweep();

    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: {
        reportRequestId: { in: [submitted.id, accepted.id] },
        completedAt: null,
      },
      data: {
        completedAt: NOW,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastErrorCode: "delivery_timeout",
      },
    });
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(1, {
      data: {
        userId: submitted.user_id,
        action: "report_request.terminal",
        entityType: "ReportRequest",
        entityId: submitted.id,
        changes: {
          statusFrom: "email_submitted",
          statusTo: "failed",
          failureStage: "email_submission",
          failureCode: "delivery_timeout",
        },
      },
    });
    expect(tx.auditLog.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        userId: accepted.user_id,
        entityId: accepted.id,
        changes: expect.objectContaining({ statusFrom: "email_accepted" }),
      }),
    });
  });

  it("does not write jobs or audits when no unlocked due request is returned", async () => {
    const { reaper, tx } = makeHarness();

    await expect(reaper.sweep()).resolves.toEqual({
      timedOutCount: 0,
      reportRequestIds: [],
    });
    expect(tx.reportJob.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("allows cooperative sweepers to observe a row only once", async () => {
    const { prisma, tx } = makeHarness();
    tx.$queryRaw
      .mockResolvedValueOnce([accepted])
      .mockResolvedValueOnce([]);
    const first = new ReportDeliveryDeadlineReaper(
      prisma as unknown as PrismaClient,
      clock,
    );
    const second = new ReportDeliveryDeadlineReaper(
      prisma as unknown as PrismaClient,
      clock,
    );

    await expect(Promise.all([first.sweep(), second.sweep()])).resolves.toEqual([
      { timedOutCount: 1, reportRequestIds: [accepted.id] },
      { timedOutCount: 0, reportRequestIds: [] },
    ]);
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.reportJob.updateMany).toHaveBeenCalledOnce();
  });

  it("rejects invalid configuration and invalid injected clock values", async () => {
    const { prisma } = makeHarness();
    expect(() => new ReportDeliveryDeadlineReaper(
      prisma as unknown as PrismaClient,
      clock,
      { batchSize: 0 },
    )).toThrow("batchSize must be a positive safe integer");

    const invalidClock: Clock = { now: () => new Date(Number.NaN) };
    const reaper = new ReportDeliveryDeadlineReaper(
      prisma as unknown as PrismaClient,
      invalidClock,
    );
    await expect(reaper.sweep()).rejects.toThrow(
      "clock must return a valid Date",
    );
  });
});
