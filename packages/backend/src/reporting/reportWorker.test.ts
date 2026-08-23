import { Prisma, PrismaClient, ReportStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { CsvReportGenerator } from "./csvReportGenerator";
import { ReportDomainError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import type { ReportAttachment, ReportSnapshot } from "./models";
import type { ReportDataService } from "./reportDataService";
import type { ReportEmailService } from "./reportEmailService";
import type {
  ClaimedReportJob,
  PostgresReportJobRepository,
  ReportJobLease,
} from "./reportJobRepository";
import type { ReportRequestService } from "./reportRequestService";
import { ReportWorker } from "./reportWorker";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2025-01-15T10:20:30.000Z");
const EXPIRY = new Date("2025-01-15T10:21:30.000Z");

const snapshot: ReportSnapshot = {
  id: "snapshot-1",
  reportRequestId: REQUEST_ID,
  reportType: "weekly",
  period: {
    startDate: "2025-01-06" as never,
    endDate: "2025-01-12" as never,
    inclusive: true,
  },
  createdAt: NOW,
  entries: [],
  summary: {
    recordCount: 0,
    digitalIncomeTotal: new Prisma.Decimal(0),
    cashIncomeTotal: new Prisma.Decimal(0),
    halalIncomeTotal: new Prisma.Decimal(0),
    nonHalalIncomeTotal: new Prisma.Decimal(0),
  },
};

function attachment(bytes = new Uint8Array([65, 66, 67])): ReportAttachment {
  return {
    reportRequestId: REQUEST_ID,
    bytes,
    byteSize: bytes.byteLength,
    sha256: "a".repeat(64),
    filename: "weekly_2025-01-06_2025-01-12.csv",
    mediaType: "text/csv; charset=UTF-8",
    generatedAt: NOW,
    summary: snapshot.summary,
  };
}
type Evidence = {
  userId: string;
  status: ReportStatus;
  progressStage: string;
  snapshot: { id: string } | null;
  attachment: { id: string; byteSize: number } | null;
  delivery: {
    acceptedAt: Date | null;
    submittedAt: Date | null;
    deliveryDeadlineAt: Date | null;
  } | null;
};

function makeHarness(initial: Partial<Evidence> = {}) {
  const evidence: Evidence = {
    userId: "user-1",
    status: ReportStatus.PENDING,
    progressStage: "data_retrieval",
    snapshot: null,
    attachment: null,
    delivery: null,
    ...initial,
  };
  const claimed: ClaimedReportJob = {
    jobId: JOB_ID,
    reportRequestId: REQUEST_ID,
    workerId: "worker-a",
    availableAt: NOW,
    leaseExpiresAt: EXPIRY,
    attemptCount: 1,
    maxAttempts: 3,
    lastErrorCode: null,
  };
  const persistedAttachments: unknown[] = [];
  const reportRequest = {
    findUnique: vi.fn(async () => ({ ...evidence })),
  };
  const reportAttachment = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      persistedAttachments.push(data);
      evidence.attachment = {
        id: String(data.id),
        byteSize: Number(data.byteSize),
      };
      return data;
    }),
  };
  const prisma = { reportRequest, reportAttachment };

  const jobs = {
    claimNext: vi.fn(async () => claimed),
    heartbeat: vi.fn(async (lease: ReportJobLease) => ({ ...lease })),
    scheduleRetry: vi.fn(async () => ({
      disposition: "scheduled" as const,
      availableAt: new Date("2025-01-15T10:20:31.000Z"),
    })),
    complete: vi.fn(async () => true),
  };
  const statusMap = {
    pending: ReportStatus.PENDING,
    processing: ReportStatus.PROCESSING,
    email_submitted: ReportStatus.EMAIL_SUBMITTED,
    email_accepted: ReportStatus.EMAIL_ACCEPTED,
  } as const;
  const requests = {
    transitionNonterminal: vi.fn(async (input: any) => {
      if (!input.fromStatuses.some((status: keyof typeof statusMap) =>
        statusMap[status] === evidence.status)) return null;
      evidence.status = statusMap[input.toStatus as keyof typeof statusMap];
      evidence.progressStage = input.progressStage;
      return { status: input.toStatus };
    }),
    recordFailure: vi.fn(async ({ failure }: any) => {
      evidence.status = ReportStatus.FAILED;
      return { status: "failed", failure: failure.toPublicFailure() };
    }),
  };
  const data = {
    readSnapshot: vi.fn(async () => evidence.snapshot === null ? null : snapshot),
    createSnapshot: vi.fn(async () => {
      evidence.snapshot = { id: snapshot.id };
      return snapshot;
    }),
  };
  const csv = { generate: vi.fn(() => attachment()) };
  const email = {
    submit: vi.fn(async () => {
      evidence.status = ReportStatus.EMAIL_ACCEPTED;
      evidence.delivery = {
        acceptedAt: NOW,
        submittedAt: NOW,
        deliveryDeadlineAt: new Date(NOW.getTime() + 300_000),
      };
      return {
        disposition: "accepted" as const,
        status: "email_accepted" as const,
        providerMessageId: "provider-1",
        submittedAt: NOW,
        acceptedAt: NOW,
        deliveryDeadlineAt: new Date(NOW.getTime() + 300_000),
      };
    }),
  };
  const ids: IdGenerator = { generate: () => ATTACHMENT_ID };
  const clock: Clock = { now: () => new Date(NOW) };
  const worker = new ReportWorker(
    prisma as unknown as PrismaClient,
    jobs as unknown as PostgresReportJobRepository,
    requests as unknown as ReportRequestService,
    data as unknown as ReportDataService,
    csv as unknown as CsvReportGenerator,
    email as unknown as ReportEmailService,
    {
      workerId: "worker-a",
      leaseDurationMs: 60_000,
      attachmentLimitBytes: 10,
      clock,
    },
    ids,
  );
  return {
    worker,
    evidence,
    jobs,
    requests,
    data,
    csv,
    email,
    reportAttachment,
    persistedAttachments,
  };
}
describe("ReportWorker", () => {
  it("runs the durable snapshot, attachment, submission, acceptance, and acknowledgment pipeline", async () => {
    const harness = makeHarness();

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: REQUEST_ID,
    });

    expect(harness.data.createSnapshot).toHaveBeenCalledOnce();
    expect(harness.csv.generate).toHaveBeenCalledWith(snapshot);
    expect(harness.reportAttachment.create).toHaveBeenCalledOnce();
    expect(harness.persistedAttachments[0]).toMatchObject({
      id: ATTACHMENT_ID,
      reportRequestId: REQUEST_ID,
      content: Buffer.from([65, 66, 67]),
      byteSize: 3,
      filename: "weekly_2025-01-06_2025-01-12.csv",
    });
    expect(harness.email.submit).toHaveBeenCalledWith(REQUEST_ID);
    expect(harness.jobs.complete).toHaveBeenCalledOnce();
    expect(harness.requests.recordFailure).not.toHaveBeenCalled();
  });

  it("resumes from a persisted attachment without re-querying source rows or regenerating", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
    });

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "acknowledged",
    });

    expect(harness.data.readSnapshot).not.toHaveBeenCalled();
    expect(harness.data.createSnapshot).not.toHaveBeenCalled();
    expect(harness.csv.generate).not.toHaveBeenCalled();
    expect(harness.reportAttachment.create).not.toHaveBeenCalled();
    expect(harness.email.submit).toHaveBeenCalledOnce();
  });

  it("acknowledges durable acceptance without reading artifacts or resubmitting", async () => {
    const harness = makeHarness({
      status: ReportStatus.EMAIL_ACCEPTED,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
      delivery: {
        acceptedAt: NOW,
        submittedAt: NOW,
        deliveryDeadlineAt: new Date(NOW.getTime() + 300_000),
      },
    });

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "acknowledged",
    });

    expect(harness.data.readSnapshot).not.toHaveBeenCalled();
    expect(harness.csv.generate).not.toHaveBeenCalled();
    expect(harness.email.submit).not.toHaveBeenCalled();
    expect(harness.jobs.complete).toHaveBeenCalledOnce();
  });

  it("fails an oversized UTF-8 attachment before persistence or provider submission", async () => {
    const harness = makeHarness();
    harness.csv.generate.mockReturnValue(attachment(new Uint8Array(11)));

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "failed",
      reportRequestId: REQUEST_ID,
      errorCode: "report_too_large",
    });

    expect(harness.reportAttachment.create).not.toHaveBeenCalled();
    expect(harness.email.submit).not.toHaveBeenCalled();
    expect(harness.requests.recordFailure).toHaveBeenCalledWith({
      reportRequestId: REQUEST_ID,
      failure: expect.objectContaining({
        code: "report_too_large",
        stage: "report_size",
      }),
    });
  });
  it("schedules bounded repository backoff for a transient provider failure", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
    });
    harness.email.submit.mockRejectedValue(new ReportDomainError("provider_unavailable"));

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "retry_scheduled",
      reportRequestId: REQUEST_ID,
      availableAt: new Date("2025-01-15T10:20:31.000Z"),
    });

    expect(harness.jobs.scheduleRetry).toHaveBeenCalledWith({
      lease: expect.objectContaining({ jobId: JOB_ID, workerId: "worker-a" }),
      errorCode: "provider_unavailable",
    });
    expect(harness.requests.recordFailure).not.toHaveBeenCalled();
  });

  it("persists the failure stage when transient attempts are exhausted", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
    });
    harness.email.submit.mockRejectedValue(new ReportDomainError("provider_response_invalid"));
    harness.jobs.scheduleRetry.mockResolvedValue({ disposition: "exhausted" });

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "provider_response_invalid",
    });

    expect(harness.requests.recordFailure).toHaveBeenCalledWith({
      reportRequestId: REQUEST_ID,
      failure: expect.objectContaining({
        code: "provider_response_invalid",
        stage: "email_submission",
      }),
    });
  });

  it("treats missing required cash as permanent and preserves the snapshot", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
    });
    harness.csv.generate.mockImplementation(() => {
      throw new ReportDomainError("missing_required_cash_amount");
    });

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "missing_required_cash_amount",
    });

    expect(harness.jobs.scheduleRetry).not.toHaveBeenCalled();
    expect(harness.reportAttachment.create).not.toHaveBeenCalled();
    expect(harness.evidence.snapshot).toEqual({ id: snapshot.id });
  });

  it("never re-queries mutable source rows when a persisted snapshot marker cannot be read", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
    });
    harness.data.readSnapshot.mockResolvedValue(null);

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "unexpected_report_error",
    });

    expect(harness.data.createSnapshot).not.toHaveBeenCalled();
    expect(harness.csv.generate).not.toHaveBeenCalled();
    expect(harness.email.submit).not.toHaveBeenCalled();
  });

  it("never reconstructs missing durable stages from stronger attachment evidence", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: null,
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
    });

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "unexpected_report_error",
    });

    expect(harness.data.readSnapshot).not.toHaveBeenCalled();
    expect(harness.data.createSnapshot).not.toHaveBeenCalled();
    expect(harness.csv.generate).not.toHaveBeenCalled();
    expect(harness.email.submit).not.toHaveBeenCalled();
  });

  it("retries raw database failures instead of treating them as permanent", async () => {
    const harness = makeHarness({ status: ReportStatus.PROCESSING });
    harness.data.readSnapshot.mockRejectedValue(new Error("database unavailable"));

    await expect(harness.worker.runOnce()).resolves.toMatchObject({
      disposition: "retry_scheduled",
      reportRequestId: REQUEST_ID,
    });

    expect(harness.jobs.scheduleRetry).toHaveBeenCalledWith({
      lease: expect.objectContaining({ jobId: JOB_ID }),
      errorCode: "unexpected_report_error",
    });
    expect(harness.requests.recordFailure).not.toHaveBeenCalled();
  });

  it("fails at the exact durable delivery deadline without resubmitting", async () => {
    const submittedAt = new Date(NOW.getTime() - 300_000);
    const harness = makeHarness({
      status: ReportStatus.EMAIL_SUBMITTED,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
      delivery: {
        acceptedAt: null,
        submittedAt,
        deliveryDeadlineAt: NOW,
      },
    });

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "failed",
      reportRequestId: REQUEST_ID,
      errorCode: "delivery_timeout",
    });

    expect(harness.email.submit).not.toHaveBeenCalled();
    expect(harness.requests.recordFailure).toHaveBeenCalledWith({
      reportRequestId: REQUEST_ID,
      failure: expect.objectContaining({
        code: "delivery_timeout",
        stage: "email_submission",
      }),
    });
  });

  it("acknowledges a concurrent terminal transition returned by submission", async () => {
    const harness = makeHarness({
      status: ReportStatus.PROCESSING,
      snapshot: { id: snapshot.id },
      attachment: { id: ATTACHMENT_ID, byteSize: 3 },
    });
    harness.email.submit.mockImplementation(async () => {
      harness.evidence.status = ReportStatus.SENT;
      return null;
    });

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: REQUEST_ID,
    });

    expect(harness.email.submit).toHaveBeenCalledOnce();
    expect(harness.jobs.complete).not.toHaveBeenCalled();
  });

  it("acknowledges a request that became terminal after claim without processing it", async () => {
    const harness = makeHarness({ status: ReportStatus.SENT });

    await expect(harness.worker.runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: REQUEST_ID,
    });

    expect(harness.requests.transitionNonterminal).not.toHaveBeenCalled();
    expect(harness.data.readSnapshot).not.toHaveBeenCalled();
    expect(harness.email.submit).not.toHaveBeenCalled();
    expect(harness.jobs.complete).not.toHaveBeenCalled();
  });
});
