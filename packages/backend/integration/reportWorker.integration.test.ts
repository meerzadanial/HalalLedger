import { randomUUID } from "node:crypto";
import {
  PrismaClient,
  ReportFailureStage,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CsvReportGenerator } from "../src/reporting/csvReportGenerator";
import { ReportDomainError } from "../src/reporting/errors";
import type { Clock } from "../src/reporting/infrastructure";
import type {
  EmailProvider,
  EmailProviderAcceptance,
  EmailProviderCommand,
  ProviderWebhookHeaders,
} from "../src/reporting/provider";
import { EmailProviderSubmissionError } from "../src/reporting/provider";
import { ReportDataService } from "../src/reporting/reportDataService";
import { ReportDeliveryDeadlineReaper } from "../src/reporting/reportDeliveryDeadlineReaper";
import { ReportEmailService } from "../src/reporting/reportEmailService";
import { PostgresReportJobRepository } from "../src/reporting/reportJobRepository";
import { ReportPeriodResolver } from "../src/reporting/reportPeriodResolver";
import { ReportRequestService } from "../src/reporting/reportRequestService";
import { ReportWorker } from "../src/reporting/reportWorker";

const databaseUrl = process.env.DATABASE_URL;
if (
  databaseUrl === undefined ||
  !new URL(databaseUrl).pathname.includes("bulk_report_integration_")
) {
  throw new Error(
    "Worker integration tests require the generated disposable database.",
  );
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const START = new Date("2025-01-15T10:00:00.000Z");

class MutableClock implements Clock {
  constructor(private instant = new Date(START)) {}
  now(): Date { return new Date(this.instant); }
  set(value: Date): void { this.instant = new Date(value); }
  advance(milliseconds: number): void {
    this.instant = new Date(this.instant.getTime() + milliseconds);
  }
}
class IdempotentFakeProvider implements EmailProvider {
  readonly calls: EmailProviderCommand[] = [];
  readonly logicalMessages = new Map<string, EmailProviderAcceptance>();
  mode: "accept" | "ambiguous_once" | "reject" = "accept";
  private readonly ambiguousKeys = new Set<string>();

  constructor(private readonly clock: Clock) {}

  async submit(command: EmailProviderCommand): Promise<EmailProviderAcceptance> {
    this.calls.push(command);
    let acceptance = this.logicalMessages.get(command.idempotencyKey);
    if (acceptance === undefined) {
      acceptance = {
        providerMessageId: `provider-${this.logicalMessages.size + 1}`,
        acceptedAt: this.clock.now(),
      };
      this.logicalMessages.set(command.idempotencyKey, acceptance);
    }
    if (this.mode === "reject") {
      this.logicalMessages.delete(command.idempotencyKey);
      throw new EmailProviderSubmissionError("rejected");
    }
    if (
      this.mode === "ambiguous_once" &&
      !this.ambiguousKeys.has(command.idempotencyKey)
    ) {
      this.ambiguousKeys.add(command.idempotencyKey);
      throw new EmailProviderSubmissionError("unavailable");
    }
    return acceptance;
  }

  verifyWebhook(_rawBody: Buffer, _headers: ProviderWebhookHeaders): never {
    throw new Error("not used by worker integration tests");
  }
}

type SeedOptions = {
  status?: ReportStatus;
  maxAttempts?: number;
  restaurantName?: string;
  hasCashOrder?: boolean;
  cashAmount?: string | null;
};

async function seedRequest(options: SeedOptions = {}) {
  const userId = randomUUID();
  const requestId = randomUUID();
  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      passwordHash: "integration-only",
    },
  });
  await prisma.reportRequest.create({
    data: {
      id: requestId,
      userId,
      clientRequestId: randomUUID(),
      reportType: ReportType.WEEKLY,
      referenceDate: new Date("2025-01-08T00:00:00.000Z"),
      periodStart: new Date("2025-01-06T00:00:00.000Z"),
      periodEnd: new Date("2025-01-12T00:00:00.000Z"),
      accountEmail: `${userId}@example.test`,
      timeZone: "Asia/Kuala_Lumpur",
      status: options.status ?? ReportStatus.PENDING,
      progressStage: "data_retrieval",
      job: {
        create: {
          id: randomUUID(),
          availableAt: new Date(START),
          maxAttempts: options.maxAttempts ?? 4,
        },
      },
    },
  });
  await prisma.deliveryEntry.create({
    data: {
      id: randomUUID(),
      userId,
      restaurantName: options.restaurantName ?? "Durable Cafe",
      restaurantStatus: "halal",
      fareAmount: "10.25",
      hasCashOrder: options.hasCashOrder ?? false,
      cashAmount: options.cashAmount ?? null,
      entryDate: new Date("2025-01-08T00:00:00.000Z"),
      timestamp: new Date("2025-01-08T08:00:00.000Z"),
    },
  });
  return { userId, requestId };
}
function services(
  clock: MutableClock,
  provider = new IdempotentFakeProvider(clock),
  options: { attachmentLimitBytes?: number; maxAttempts?: number } = {},
) {
  const jobs = new PostgresReportJobRepository(prisma, clock, undefined, {
    defaultMaxAttempts: options.maxAttempts ?? 4,
    initialBackoffMs: 100,
    maxBackoffMs: 250,
  });
  const requests = new ReportRequestService(
    prisma,
    new ReportPeriodResolver(clock),
    clock,
    undefined,
    jobs,
  );
  const data = new ReportDataService(prisma, requests);
  const csv = new CsvReportGenerator(clock);
  const email = new ReportEmailService(prisma, provider, clock, requests);
  const worker = (workerId: string, overrides: {
    data?: Pick<ReportDataService, "readSnapshot" | "createSnapshot">;
    csv?: Pick<CsvReportGenerator, "generate">;
  } = {}) => new ReportWorker(
    prisma,
    jobs,
    requests,
    overrides.data ?? data,
    overrides.csv ?? csv,
    email,
    {
      workerId,
      leaseDurationMs: 1_000,
      attachmentLimitBytes: options.attachmentLimitBytes,
      clock,
    },
  );
  return { jobs, requests, data, csv, email, provider, worker };
}

async function seedSnapshotAndAttachment(
  requestId: string,
  userId: string,
  clock: MutableClock,
  includeAttachment: boolean,
) {
  const setup = services(clock);
  const snapshot = await setup.data.createSnapshot(
    { reportRequestId: requestId, userId },
    { recordFailure: false },
  );
  if (!includeAttachment) return { snapshot, attachment: null };
  const attachment = setup.csv.generate(snapshot);
  await prisma.reportAttachment.create({
    data: {
      id: randomUUID(),
      reportRequestId: requestId,
      content: Buffer.from(attachment.bytes),
      byteSize: attachment.byteSize,
      sha256: attachment.sha256,
      filename: attachment.filename,
      mediaType: attachment.mediaType,
      generatedAt: attachment.generatedAt,
    },
  });
  return { snapshot, attachment };
}

beforeAll(async () => prisma.$connect(), 30_000);
beforeEach(async () => {
  await prisma.providerEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});
afterAll(async () => prisma.$disconnect(), 30_000);

describe("durable ReportJob PostgreSQL protocol", () => {
  it("serializes concurrent claims, reclaims expiry, and bounds exponential backoff attempts", async () => {
    const clock = new MutableClock();
    const { requestId } = await seedRequest({ maxAttempts: 3 });
    const repo = services(clock).jobs;

    const claims = await Promise.all([
      repo.claimNext({ workerId: "worker-a", leaseDurationMs: 1_000 }),
      repo.claimNext({ workerId: "worker-b", leaseDurationMs: 1_000 }),
    ]);
    const first = claims.find((claim) => claim !== null);
    expect(claims.filter((claim) => claim !== null)).toHaveLength(1);
    expect(first).toMatchObject({ reportRequestId: requestId, attemptCount: 1 });

    clock.advance(1_000);
    await expect(repo.reclaimExpiredLeases()).resolves.toEqual({
      reclaimedCount: 1,
      exhaustedReportRequestIds: [],
    });
    const second = await repo.claimNext({
      workerId: "worker-b",
      leaseDurationMs: 1_000,
    });
    expect(second).toMatchObject({ attemptCount: 2 });
    const retry = await repo.scheduleRetry({
      lease: second!,
      errorCode: "provider_unavailable",
    });
    expect(retry).toEqual({
      disposition: "scheduled",
      availableAt: new Date(clock.now().getTime() + 200),
    });

    clock.advance(199);
    await expect(repo.claimNext({ workerId: "early", leaseDurationMs: 1_000 }))
      .resolves.toBeNull();
    clock.advance(1);
    const third = await repo.claimNext({ workerId: "worker-c", leaseDurationMs: 1_000 });
    expect(third).toMatchObject({ attemptCount: 3, maxAttempts: 3 });
    await expect(repo.scheduleRetry({
      lease: third!,
      errorCode: "provider_unavailable",
    })).resolves.toEqual({ disposition: "exhausted" });
    expect(await prisma.reportJob.findUniqueOrThrow({ where: { reportRequestId: requestId } }))
      .toMatchObject({ attemptCount: 3, lastErrorCode: "provider_unavailable" });
  });
});
describe("ReportWorker durable restart integration", () => {
  it("resumes from each durable stage and reuses snapshots and attachments", async () => {
    const clock = new MutableClock();

    const pending = await seedRequest({ restaurantName: "Pending Source" });
    const pendingSetup = services(clock);
    await expect(pendingSetup.worker("pending-worker").runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: pending.requestId,
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: pending.requestId } }))
      .toMatchObject({ status: ReportStatus.EMAIL_ACCEPTED });
    expect(await prisma.reportSnapshot.count({ where: { reportRequestId: pending.requestId } })).toBe(1);
    expect(await prisma.reportAttachment.count({ where: { reportRequestId: pending.requestId } })).toBe(1);

    const snapshotted = await seedRequest({
      status: ReportStatus.PROCESSING,
      restaurantName: "Immutable Original",
    });
    await seedSnapshotAndAttachment(
      snapshotted.requestId,
      snapshotted.userId,
      clock,
      false,
    );
    await prisma.deliveryEntry.updateMany({
      where: { userId: snapshotted.userId },
      data: { restaurantName: "Mutable Replacement", fareAmount: "999.99" },
    });
    const snapshotSetup = services(clock);
    let snapshotReads = 0;
    const snapshotData = {
      readSnapshot: async (input: Parameters<ReportDataService["readSnapshot"]>[0]) => {
        snapshotReads += 1;
        return snapshotSetup.data.readSnapshot(input);
      },
      createSnapshot: async () => {
        throw new Error("source rows must not be queried after snapshot commit");
      },
    };
    await expect(snapshotSetup.worker("snapshot-worker", { data: snapshotData }).runOnce())
      .resolves.toMatchObject({ disposition: "acknowledged" });
    expect(snapshotReads).toBe(1);
    const snapshotCsv = Buffer.from((await prisma.reportAttachment.findUniqueOrThrow({
      where: { reportRequestId: snapshotted.requestId },
    })).content).toString("utf8");
    expect(snapshotCsv).toContain("Immutable Original");
    expect(snapshotCsv).not.toContain("Mutable Replacement");

    const attached = await seedRequest({ status: ReportStatus.PROCESSING });
    const persisted = await seedSnapshotAndAttachment(
      attached.requestId,
      attached.userId,
      clock,
      true,
    );
    const persistedBytes = Buffer.from(persisted.attachment!.bytes);
    const attachmentSetup = services(clock);
    const forbiddenData = {
      readSnapshot: async () => { throw new Error("snapshot must not be reread"); },
      createSnapshot: async () => { throw new Error("source must not be queried"); },
    };
    const forbiddenCsv = {
      generate: () => { throw new Error("attachment must not be regenerated"); },
    };
    await expect(attachmentSetup.worker("attachment-worker", {
      data: forbiddenData,
      csv: forbiddenCsv,
    }).runOnce()).resolves.toMatchObject({ disposition: "acknowledged" });
    expect(Buffer.from(attachmentSetup.provider.calls[0].attachment.bytes))
      .toEqual(persistedBytes);

    const submitted = await seedRequest({ status: ReportStatus.EMAIL_SUBMITTED });
    await seedSnapshotAndAttachment(submitted.requestId, submitted.userId, clock, true);
    await prisma.reportDelivery.create({
      data: {
        id: randomUUID(),
        reportRequestId: submitted.requestId,
        idempotencyKey: `report:${submitted.requestId}`,
        submittedAt: clock.now(),
        deliveryDeadlineAt: new Date(clock.now().getTime() + 300_000),
      },
    });
    const submittedSetup = services(clock);
    await expect(submittedSetup.worker("submitted-worker", {
      data: forbiddenData,
      csv: forbiddenCsv,
    }).runOnce()).resolves.toMatchObject({ disposition: "acknowledged" });
    expect(submittedSetup.provider.calls).toHaveLength(1);
    expect(submittedSetup.provider.calls[0].idempotencyKey)
      .toBe(`report:${submitted.requestId}`);

    const accepted = await seedRequest({ status: ReportStatus.EMAIL_ACCEPTED });
    await seedSnapshotAndAttachment(accepted.requestId, accepted.userId, clock, true);
    await prisma.reportDelivery.create({
      data: {
        id: randomUUID(),
        reportRequestId: accepted.requestId,
        idempotencyKey: `report:${accepted.requestId}`,
        providerMessageId: `accepted-${accepted.requestId}`,
        submittedAt: clock.now(),
        acceptedAt: clock.now(),
        deliveryDeadlineAt: new Date(clock.now().getTime() + 300_000),
      },
    });
    const acceptedSetup = services(clock);
    await expect(acceptedSetup.worker("accepted-worker", {
      data: forbiddenData,
      csv: forbiddenCsv,
    }).runOnce()).resolves.toMatchObject({ disposition: "acknowledged" });
    expect(acceptedSetup.provider.calls).toHaveLength(0);
    expect(await prisma.reportJob.findUniqueOrThrow({
      where: { reportRequestId: accepted.requestId },
    })).toMatchObject({ completedAt: expect.any(Date) });
  });

  it("retries provider timeout ambiguity as one logical email with one stable key", async () => {
    const clock = new MutableClock();
    const seeded = await seedRequest();
    const provider = new IdempotentFakeProvider(clock);
    provider.mode = "ambiguous_once";
    const setup = services(clock, provider);

    await expect(setup.worker("ambiguous-first").runOnce()).resolves.toEqual({
      disposition: "retry_scheduled",
      reportRequestId: seeded.requestId,
      availableAt: new Date(START.getTime() + 100),
    });
    const afterAmbiguity = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: seeded.requestId },
      include: { snapshot: true, attachment: true, delivery: true },
    });
    expect(afterAmbiguity).toMatchObject({
      status: ReportStatus.EMAIL_SUBMITTED,
      snapshot: expect.objectContaining({ reportRequestId: seeded.requestId }),
      attachment: expect.objectContaining({ reportRequestId: seeded.requestId }),
      delivery: expect.objectContaining({
        idempotencyKey: `report:${seeded.requestId}`,
        acceptedAt: null,
      }),
    });

    clock.advance(100);
    await expect(setup.worker("ambiguous-restart").runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: seeded.requestId,
    });
    expect(provider.calls).toHaveLength(2);
    expect(new Set(provider.calls.map((call) => call.idempotencyKey)))
      .toEqual(new Set([`report:${seeded.requestId}`]));
    expect(provider.logicalMessages.size).toBe(1);
    expect(await prisma.reportDelivery.count({ where: { reportRequestId: seeded.requestId } }))
      .toBe(1);
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: seeded.requestId } }))
      .toMatchObject({ status: ReportStatus.EMAIL_ACCEPTED });

    await prisma.reportJob.update({
      where: { reportRequestId: seeded.requestId },
      data: { completedAt: null, availableAt: clock.now() },
    });
    await expect(setup.worker("accepted-restart").runOnce()).resolves.toMatchObject({
      disposition: "acknowledged",
    });
    expect(provider.calls).toHaveLength(2);
  });
});

describe("ReportWorker persisted stage failures", () => {
  it("rejects oversized UTF-8 bytes before attachment persistence or provider submission", async () => {
    const clock = new MutableClock();
    const seeded = await seedRequest({ restaurantName: "多字节餐厅" });
    const setup = services(clock, undefined, { attachmentLimitBytes: 32 });

    await expect(setup.worker("size-worker").runOnce()).resolves.toEqual({
      disposition: "failed",
      reportRequestId: seeded.requestId,
      errorCode: "report_too_large",
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: seeded.requestId } }))
      .toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.REPORT_SIZE,
        failureCode: "report_too_large",
      });
    expect(await prisma.reportSnapshot.count({ where: { reportRequestId: seeded.requestId } })).toBe(1);
    expect(await prisma.reportAttachment.count({ where: { reportRequestId: seeded.requestId } })).toBe(0);
    expect(setup.provider.calls).toHaveLength(0);
  });

  it("persists data, CSV, and provider failure stages while preserving durable evidence", async () => {
    const clock = new MutableClock();

    const dataFailure = await seedRequest({ maxAttempts: 1 });
    const dataSetup = services(clock);
    const brokenData = {
      readSnapshot: async () => { throw new ReportDomainError("data_retrieval_failed"); },
      createSnapshot: async () => { throw new ReportDomainError("data_retrieval_failed"); },
    };
    await expect(dataSetup.worker("data-failure", { data: brokenData }).runOnce())
      .resolves.toMatchObject({ disposition: "failed", errorCode: "data_retrieval_failed" });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: dataFailure.requestId } }))
      .toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.DATA_RETRIEVAL,
      });

    const csvFailure = await seedRequest({
      hasCashOrder: true,
      cashAmount: null,
    });
    const csvSetup = services(clock);
    await expect(csvSetup.worker("csv-failure").runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "missing_required_cash_amount",
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: csvFailure.requestId } }))
      .toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.CSV_GENERATION,
      });
    expect(await prisma.reportSnapshot.count({ where: { reportRequestId: csvFailure.requestId } })).toBe(1);
    expect(await prisma.reportAttachment.count({ where: { reportRequestId: csvFailure.requestId } })).toBe(0);

    const emailFailure = await seedRequest();
    const rejectingProvider = new IdempotentFakeProvider(clock);
    rejectingProvider.mode = "reject";
    const emailSetup = services(clock, rejectingProvider);
    await expect(emailSetup.worker("email-failure").runOnce()).resolves.toMatchObject({
      disposition: "failed",
      errorCode: "provider_rejected",
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: emailFailure.requestId } }))
      .toMatchObject({
        status: ReportStatus.FAILED,
        failureStage: ReportFailureStage.EMAIL_SUBMISSION,
      });
    expect(await prisma.reportAttachment.count({ where: { reportRequestId: emailFailure.requestId } })).toBe(1);
    expect(rejectingProvider.calls).toHaveLength(1);
  });
});

describe("ReportDeliveryDeadlineReaper PostgreSQL boundary", () => {
  it("keeps requests live at 299.999 seconds and fails unconfirmed requests at exactly 300 seconds", async () => {
    const submittedAt = new Date(START);
    const clock = new MutableClock(submittedAt);
    const submitted = await seedRequest({ status: ReportStatus.EMAIL_SUBMITTED });
    const accepted = await seedRequest({ status: ReportStatus.EMAIL_ACCEPTED });
    const confirmed = await seedRequest({ status: ReportStatus.EMAIL_ACCEPTED });
    for (const [seeded, acceptedAt, confirmedAt] of [
      [submitted, null, null],
      [accepted, submittedAt, null],
      [confirmed, submittedAt, new Date(submittedAt.getTime() + 299_000)],
    ] as const) {
      await prisma.reportDelivery.create({
        data: {
          id: randomUUID(),
          reportRequestId: seeded.requestId,
          idempotencyKey: `report:${seeded.requestId}`,
          providerMessageId: acceptedAt === null ? null : `provider-${seeded.requestId}`,
          submittedAt,
          acceptedAt,
          confirmedAt,
          deliveryDeadlineAt: new Date(submittedAt.getTime() + 300_000),
        },
      });
    }
    const reaper = new ReportDeliveryDeadlineReaper(prisma, clock);

    clock.set(new Date(submittedAt.getTime() + 299_999));
    await expect(reaper.sweep()).resolves.toEqual({
      timedOutCount: 0,
      reportRequestIds: [],
    });
    expect((await prisma.reportRequest.findMany({
      where: { id: { in: [submitted.requestId, accepted.requestId] } },
      orderBy: { id: "asc" },
    })).every((row) => row.status !== ReportStatus.FAILED)).toBe(true);

    clock.advance(1);
    const exact = await reaper.sweep();
    expect(exact.timedOutCount).toBe(2);
    expect(new Set(exact.reportRequestIds)).toEqual(
      new Set([submitted.requestId, accepted.requestId]),
    );
    const timedOut = await prisma.reportRequest.findMany({
      where: { id: { in: [submitted.requestId, accepted.requestId] } },
    });
    expect(timedOut).toHaveLength(2);
    expect(timedOut.every((row) =>
      row.status === ReportStatus.FAILED &&
      row.failureStage === ReportFailureStage.EMAIL_SUBMISSION &&
      row.failureCode === "delivery_timeout"
    )).toBe(true);
    expect(await prisma.reportJob.count({
      where: {
        reportRequestId: { in: [submitted.requestId, accepted.requestId] },
        completedAt: { not: null },
        lastErrorCode: "delivery_timeout",
      },
    })).toBe(2);
    expect(await prisma.auditLog.count({
      where: {
        entityId: { in: [submitted.requestId, accepted.requestId] },
        action: "report_request.terminal",
      },
    })).toBe(2);

    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: confirmed.requestId } }))
      .toMatchObject({ status: ReportStatus.EMAIL_ACCEPTED });
    const requestService = services(clock).requests;
    await expect(requestService.markSent({
      reportRequestId: accepted.requestId,
      confirmedAt: new Date(clock.now().getTime() + 1),
    })).resolves.toBeNull();
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: accepted.requestId } }))
      .toMatchObject({ status: ReportStatus.FAILED, failureCode: "delivery_timeout" });
  });
});
