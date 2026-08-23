import {
  PrismaClient,
  ReportFailureStage,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReportDomainError, ReportInProgressError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { ReportPeriodResolver } from "./reportPeriodResolver";
import { ReportRequestService } from "./reportRequestService";
import type { ReportDateString } from "./temporal";

const USER_ID = "user-1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const RETRY_CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2025-01-15T10:20:30.000Z");

const clock: Clock = { now: () => new Date(NOW) };

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    userId: USER_ID,
    clientRequestId: CLIENT_ID,
    retryOfId: null,
    reportType: ReportType.WEEKLY,
    referenceDate: new Date("2025-01-08T00:00:00.000Z"),
    periodStart: new Date("2025-01-06T00:00:00.000Z"),
    periodEnd: new Date("2025-01-12T00:00:00.000Z"),
    accountEmail: "account@example.com",
    timeZone: "Asia/Kuala_Lumpur",
    status: ReportStatus.PENDING,
    progressStage: "data_retrieval",
    failureStage: null,
    failureCode: null,
    createdAt: NOW,
    updatedAt: NOW,
    sentAt: null,
    delivery: null,
    ...overrides,
  };
}
function makeHarness() {
  const tx = {
    user: { findUnique: vi.fn() },
    reportRequest: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    reportDelivery: { updateMany: vi.fn() },
    reportJob: {
      upsert: vi.fn().mockImplementation(async ({ create }: any) => ({
        ...create,
        leaseOwner: null,
        leaseExpiresAt: null,
        attemptCount: 0,
        lastErrorCode: null,
        completedAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      })),
      updateMany: vi.fn(),
    },
    auditLog: { create: vi.fn() },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const generated = [REQUEST_ID, "44444444-4444-4444-8444-444444444444"];
  const ids: IdGenerator = { generate: () => generated.shift()! };
  const service = new ReportRequestService(
    prisma as unknown as PrismaClient,
    new ReportPeriodResolver(clock),
    clock,
    ids,
  );
  return { service, prisma, tx };
}

describe("ReportRequestService", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("atomically derives account fields and creates the request, job, and audit", async () => {
    const { service, tx, prisma } = makeHarness();
    tx.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "fresh@example.com",
      timeZone: "Asia/Kuala_Lumpur",
    });
    tx.reportRequest.findUnique.mockResolvedValue(null);
    tx.reportRequest.findFirst.mockResolvedValue(null);
    tx.reportRequest.create.mockImplementation(async ({ data }: any) =>
      row({
        id: data.id,
        accountEmail: data.accountEmail,
        timeZone: data.timeZone,
        reportType: data.reportType,
        referenceDate: data.referenceDate,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
      }),
    );

    const result = await service.create({
      userId: USER_ID,
      reportType: "weekly",
      referenceDate: "2025-01-08" as ReportDateString,
      clientRequestId: CLIENT_ID,
      accountEmail: "attacker@example.com",
      status: "sent",
    } as any);

    expect(result.disposition).toBe("created");
    expect(result.request.accountEmail).toBe("fresh@example.com");
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    const data = tx.reportRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      userId: USER_ID,
      accountEmail: "fresh@example.com",
      timeZone: "Asia/Kuala_Lumpur",
      status: ReportStatus.PENDING,
      progressStage: "data_retrieval",
    });
    expect(tx.reportJob.upsert).toHaveBeenCalledWith({
      where: { reportRequestId: REQUEST_ID },
      create: expect.objectContaining({
        id: "44444444-4444-4444-8444-444444444444",
        reportRequestId: REQUEST_ID,
        availableAt: NOW,
        maxAttempts: 8,
      }),
      update: {},
    });
    expect(data).not.toHaveProperty("job");
    expect(data).not.toHaveProperty("failureCode");
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "report_request.created",
        entityId: REQUEST_ID,
      }),
    });
  });
  it("returns a replay for an identical key and rejects a conflicting payload", async () => {
    const identical = makeHarness();
    identical.tx.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "new@example.com",
      timeZone: "UTC",
    });
    identical.tx.reportRequest.findUnique.mockResolvedValue(row());

    const replay = await identical.service.create({
      userId: USER_ID,
      reportType: "weekly",
      referenceDate: "2025-01-08" as ReportDateString,
      clientRequestId: CLIENT_ID,
    });
    expect(replay.disposition).toBe("replayed");
    expect(identical.tx.reportRequest.create).not.toHaveBeenCalled();

    const conflicting = makeHarness();
    conflicting.tx.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "account@example.com",
      timeZone: "UTC",
    });
    conflicting.tx.reportRequest.findUnique.mockResolvedValue(row());
    await expect(conflicting.service.create({
      userId: USER_ID,
      reportType: "monthly",
      referenceDate: "2025-01-08" as ReportDateString,
      clientRequestId: CLIENT_ID,
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("returns the owned active request with an in-progress conflict", async () => {
    const { service, tx } = makeHarness();
    tx.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "account@example.com",
      timeZone: "UTC",
    });
    tx.reportRequest.findUnique.mockResolvedValue(null);
    tx.reportRequest.findFirst.mockResolvedValue(row({
      status: ReportStatus.PROCESSING,
      progressStage: "snapshot",
    }));

    let caught: unknown;
    try {
      await service.create({
        userId: USER_ID,
        reportType: "weekly",
        referenceDate: "2025-01-08" as ReportDateString,
        clientRequestId: RETRY_CLIENT_ID,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportInProgressError);
    expect(caught).toMatchObject({
      code: "report_in_progress",
      activeRequest: { id: REQUEST_ID, status: "processing" },
    });
    expect(tx.reportRequest.create).not.toHaveBeenCalled();
  });
  it("creates an idempotent retry linked to an unchanged owned failed request", async () => {
    const { service, tx } = makeHarness();
    tx.user.findUnique.mockResolvedValue({
      id: USER_ID,
      email: "current@example.com",
      timeZone: "Asia/Kuala_Lumpur",
    });
    tx.reportRequest.findFirst
      .mockResolvedValueOnce({
        status: ReportStatus.FAILED,
        reportType: ReportType.MONTHLY,
        referenceDate: new Date("2025-01-05T00:00:00.000Z"),
      })
      .mockResolvedValueOnce(null);
    tx.reportRequest.findUnique.mockResolvedValue(null);
    tx.reportRequest.create.mockImplementation(async ({ data }: any) =>
      row({
        id: data.id,
        clientRequestId: RETRY_CLIENT_ID,
        retryOfId: REQUEST_ID,
        reportType: data.reportType,
        referenceDate: data.referenceDate,
        periodStart: data.periodStart,
        periodEnd: data.periodEnd,
        accountEmail: data.accountEmail,
      }),
    );

    const result = await service.retry({
      userId: USER_ID,
      reportRequestId: REQUEST_ID,
      clientRequestId: RETRY_CLIENT_ID,
    });

    expect(result.disposition).toBe("created");
    expect(tx.reportRequest.create.mock.calls[0][0].data).toMatchObject({
      retryOfId: REQUEST_ID,
      reportType: ReportType.MONTHLY,
      accountEmail: "current@example.com",
    });
    expect(tx.reportRequest.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create.mock.calls[0][0].data.action)
      .toBe("report_request.retried");
  });

  it("records a typed failure with a CAS update, job completion, and terminal audit", async () => {
    const { service, tx } = makeHarness();
    const candidate = row({
      status: ReportStatus.PROCESSING,
      progressStage: "snapshot",
    });
    const failed = row({
      status: ReportStatus.FAILED,
      progressStage: "snapshot",
      failureStage: ReportFailureStage.SNAPSHOT,
      failureCode: "snapshot_failed",
    });
    tx.reportRequest.findFirst.mockResolvedValue(candidate);
    tx.reportRequest.updateMany.mockResolvedValue({ count: 1 });
    tx.reportRequest.findUnique.mockResolvedValue(failed);
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.recordFailure({
      reportRequestId: REQUEST_ID,
      failure: new ReportDomainError("snapshot_failed"),
    });

    expect(result).toMatchObject({
      status: "failed",
      canRetry: true,
      failure: { code: "snapshot_failed", stage: "snapshot" },
    });
    expect(tx.reportRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: ReportStatus.PROCESSING },
      data: expect.objectContaining({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.SNAPSHOT,
        failureCode: "snapshot_failed",
      }),
    });
    expect(tx.reportJob.updateMany).toHaveBeenCalledWith({
      where: { reportRequestId: REQUEST_ID, completedAt: null },
      data: expect.objectContaining({ completedAt: NOW }),
    });
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      statusFrom: "processing",
      statusTo: "failed",
      failureCode: "snapshot_failed",
    });
  });
  it("uses compare-and-set transitions and treats stale terminal events as no-ops", async () => {
    const transition = makeHarness();
    transition.tx.reportRequest.updateMany.mockResolvedValue({ count: 1 });
    transition.tx.reportRequest.findUnique.mockResolvedValue(row({
      status: ReportStatus.PROCESSING,
      progressStage: "snapshot",
    }));

    const changed = await transition.service.transitionNonterminal({
      reportRequestId: REQUEST_ID,
      fromStatuses: ["pending"],
      toStatus: "processing",
      progressStage: "snapshot",
    });
    expect(changed?.status).toBe("processing");
    expect(transition.tx.reportRequest.updateMany.mock.calls[0][0].where)
      .toEqual({ id: REQUEST_ID, status: { in: [ReportStatus.PENDING] } });

    const stale = makeHarness();
    stale.tx.reportRequest.findFirst.mockResolvedValue(null);
    expect(await stale.service.recordFailure({
      reportRequestId: REQUEST_ID,
      failure: new ReportDomainError("delivery_timeout"),
    })).toBeNull();
    expect(stale.tx.auditLog.create).not.toHaveBeenCalled();
    expect(stale.tx.reportJob.updateMany).not.toHaveBeenCalled();
  });

  it("atomically confirms an accepted delivery and marks the request sent", async () => {
    const { service, tx } = makeHarness();
    tx.reportRequest.findFirst.mockResolvedValue(row({
      status: ReportStatus.EMAIL_ACCEPTED,
      progressStage: "delivery_wait",
      delivery: { acceptedAt: new Date("2025-01-15T10:20:00.000Z") },
    }));
    tx.reportDelivery.updateMany.mockResolvedValue({ count: 1 });
    tx.reportRequest.updateMany.mockResolvedValue({ count: 1 });
    tx.reportJob.updateMany.mockResolvedValue({ count: 1 });
    tx.reportRequest.findUnique.mockResolvedValue(row({
      status: ReportStatus.SENT,
      progressStage: "delivery_wait",
      sentAt: NOW,
      delivery: { acceptedAt: new Date("2025-01-15T10:20:00.000Z") },
    }));

    const result = await service.markSent({ reportRequestId: REQUEST_ID });

    expect(result).toMatchObject({ status: "sent", canRetry: false });
    expect(tx.reportDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        reportRequestId: REQUEST_ID,
        acceptedAt: { not: null },
        confirmedAt: null,
      },
      data: { confirmedAt: NOW },
    });
    expect(tx.auditLog.create.mock.calls[0][0].data.changes).toMatchObject({
      statusFrom: "email_accepted",
      statusTo: "sent",
    });
  });

  it("scopes status reads to the authenticated owner", async () => {
    const { service, prisma } = makeHarness();
    prisma.reportRequest.findFirst.mockResolvedValue(row());
    const result = await service.getOwnedRequest(USER_ID, REQUEST_ID);
    expect(result?.id).toBe(REQUEST_ID);
    expect(prisma.reportRequest.findFirst).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, userId: USER_ID },
      include: { delivery: { select: { acceptedAt: true } } },
    });
  });
});
