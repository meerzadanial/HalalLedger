import { Prisma, PrismaClient, ReportStatus } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REPORT_ATTACHMENT_LIMIT_BYTES } from "./constants";
import type { CsvReportGenerator } from "./csvReportGenerator";
import type { ReportDomainError } from "./errors";
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
const MULTIBYTE_MARKER = "é€😀";

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

type Payload = { text: string; bytes: Uint8Array };

const payloadCache = new Map<number, Payload>();

function payloadWithExactUtf8Size(targetByteSize: number): Payload {
  const cached = payloadCache.get(targetByteSize);
  if (cached !== undefined) return cached;

  const encoder = new TextEncoder();
  const markerByteSize = encoder.encode(MULTIBYTE_MARKER).byteLength;
  const text = MULTIBYTE_MARKER + "a".repeat(targetByteSize - markerByteSize);
  const payload = { text, bytes: encoder.encode(text) };
  payloadCache.set(targetByteSize, payload);
  return payload;
}

function generatedAttachment(bytes: Uint8Array): ReportAttachment {
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

function makeHarness(bytes: Uint8Array) {
  const evidence: Evidence = {
    userId: "user-1",
    status: ReportStatus.PENDING,
    progressStage: "data_retrieval",
    snapshot: null,
    attachment: null,
    delivery: null,
  };
  const claimed: ClaimedReportJob = {
    jobId: JOB_ID,
    reportRequestId: REQUEST_ID,
    workerId: "worker-a",
    availableAt: NOW,
    leaseExpiresAt: new Date(NOW.getTime() + 60_000),
    attemptCount: 1,
    maxAttempts: 3,
    lastErrorCode: null,
  };
  let attachmentCreates = 0;
  let providerCalls = 0;
  let recordedFailure: ReportDomainError | null = null;

  const prisma = {
    reportRequest: {
      findUnique: async () => ({ ...evidence }),
    },
    reportAttachment: {
      create: async ({ data }: { data: { id: string; byteSize: number } }) => {
        attachmentCreates += 1;
        evidence.attachment = { id: data.id, byteSize: data.byteSize };
        return data;
      },
    },
  };
  const jobs = {
    claimNext: async () => claimed,
    heartbeat: async (lease: ReportJobLease) => ({ ...lease }),
    scheduleRetry: async () => ({
      disposition: "scheduled" as const,
      availableAt: new Date(NOW.getTime() + 1_000),
    }),
    complete: async () => true,
  };
  const statusMap: Record<string, ReportStatus> = {
    pending: ReportStatus.PENDING,
    processing: ReportStatus.PROCESSING,
    email_submitted: ReportStatus.EMAIL_SUBMITTED,
    email_accepted: ReportStatus.EMAIL_ACCEPTED,
  };
  const requests = {
    transitionNonterminal: async (input: {
      fromStatuses: string[];
      toStatus: string;
      progressStage: string;
    }) => {
      if (!input.fromStatuses.some((status) => statusMap[status] === evidence.status)) {
        return null;
      }
      evidence.status = statusMap[input.toStatus];
      evidence.progressStage = input.progressStage;
      return { status: input.toStatus };
    },
    recordFailure: async ({ failure }: { failure: ReportDomainError }) => {
      recordedFailure = failure;
      evidence.status = ReportStatus.FAILED;
      return { status: "failed", failure: failure.toPublicFailure() };
    },
  };
  const data = {
    readSnapshot: async () => null,
    createSnapshot: async () => {
      evidence.snapshot = { id: snapshot.id };
      return snapshot;
    },
  };
  const csv = { generate: () => generatedAttachment(bytes) };
  const email = {
    submit: async () => {
      providerCalls += 1;
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
    },
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
      attachmentLimitBytes: REPORT_ATTACHMENT_LIMIT_BYTES,
      clock,
    },
    ids,
  );

  return {
    worker,
    attachmentCreates: () => attachmentCreates,
    providerCalls: () => providerCalls,
    recordedFailure: () => recordedFailure,
  };
}

describe("ReportWorker UTF-8 attachment size gate", () => {
  // Feature: bulk-csv-report-email, Property 24: Attachment size gate uses UTF-8 bytes
  // **Validates: Requirements 7.9**
  it("accepts the exact UTF-8 byte limit and rejects the first oversized byte before submission", async () => {
    await fc.assert(fc.asyncProperty(
      fc.constantFrom(-1, 0, 1),
      async (boundaryOffset) => {
        const targetByteSize = REPORT_ATTACHMENT_LIMIT_BYTES + boundaryOffset;
        const payload = payloadWithExactUtf8Size(targetByteSize);

        expect(payload.text.startsWith(MULTIBYTE_MARKER)).toBe(true);
        expect(payload.text.length).toBeLessThan(payload.bytes.byteLength);
        expect(payload.bytes.byteLength).toBe(targetByteSize);

        const harness = makeHarness(payload.bytes);
        const result = await harness.worker.runOnce();

        if (targetByteSize <= REPORT_ATTACHMENT_LIMIT_BYTES) {
          expect(result).toEqual({
            disposition: "acknowledged",
            reportRequestId: REQUEST_ID,
          });
          expect(harness.attachmentCreates()).toBe(1);
          expect(harness.providerCalls()).toBe(1);
          expect(harness.recordedFailure()).toBeNull();
        } else {
          expect(result).toEqual({
            disposition: "failed",
            reportRequestId: REQUEST_ID,
            errorCode: "report_too_large",
          });
          expect(harness.attachmentCreates()).toBe(0);
          expect(harness.providerCalls()).toBe(0);
          expect(harness.recordedFailure()).toMatchObject({
            code: "report_too_large",
            stage: "report_size",
          });
        }
      },
    ), {
      numRuns: 100,
      examples: [[-1], [0], [1]],
    });
  }, 30_000);
});
