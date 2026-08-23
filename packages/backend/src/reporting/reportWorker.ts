import {
  Prisma,
  PrismaClient,
  ReportStatus as DbStatus,
} from "@prisma/client";
import {
  REPORT_ATTACHMENT_LIMIT_BYTES,
  type ReportProgressStage,
} from "./constants";
import { CsvReportGenerator } from "./csvReportGenerator";
import {
  ReportDomainError,
  isReportDomainError,
  type ReportErrorCode,
} from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { RandomUuidGenerator, SystemClock } from "./infrastructure";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";
import type { ReportAttachment, ReportSnapshot } from "./models";
import type { ReportDataService } from "./reportDataService";
import {
  REPORT_DELIVERY_DEADLINE_SECONDS,
  type ReportEmailService,
} from "./reportEmailService";
import type {
  ClaimedReportJob,
  ClaimReportJobInput,
  PostgresReportJobRepository,
  ReportJobLease,
} from "./reportJobRepository";
import type {
  PersistableReportFailureCode,
  ReportRequestService,
} from "./reportRequestService";

const REQUEST_EVIDENCE_SELECT = {
  userId: true,
  status: true,
  progressStage: true,
  snapshot: { select: { id: true } },
  attachment: { select: { id: true, byteSize: true } },
  delivery: {
    select: {
      acceptedAt: true,
      submittedAt: true,
      deliveryDeadlineAt: true,
    },
  },
} as const satisfies Prisma.ReportRequestSelect;

type RequestEvidence = Prisma.ReportRequestGetPayload<{
  select: typeof REQUEST_EVIDENCE_SELECT;
}>;
type JobRepository = Pick<
  PostgresReportJobRepository,
  "claimNext" | "heartbeat" | "scheduleRetry" | "complete"
>;
type DataService = Pick<ReportDataService, "readSnapshot" | "createSnapshot">;
type EmailService = Pick<ReportEmailService, "submit">;
type RequestService = Pick<
  ReportRequestService,
  "transitionNonterminal" | "recordFailure"
>;

export interface ReportWorkerOptions extends ClaimReportJobInput {
  readonly attachmentLimitBytes?: number;
  readonly clock?: Clock;
}

export type ReportWorkerRunResult =
  | { readonly disposition: "idle" }
  | { readonly disposition: "acknowledged"; readonly reportRequestId: string }
  | { readonly disposition: "retry_scheduled"; readonly reportRequestId: string; readonly availableAt: Date }
  | { readonly disposition: "failed"; readonly reportRequestId: string; readonly errorCode: PersistableReportFailureCode }
  | { readonly disposition: "stale"; readonly reportRequestId: string };

type FailureContext =
  | "coordination"
  | "snapshot"
  | "csv_generation"
  | "attachment_persistence"
  | "email_submission"
  | "acknowledgment";

class StaleReportJobLeaseError extends Error {}

/**
 * Runs one leased report job from durable evidence. Every restart re-reads the
 * snapshot, attachment, delivery, and acceptance rows before doing more work.
 */
export class ReportWorker {
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly attachmentLimitBytes: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly jobs: JobRepository,
    private readonly requests: RequestService,
    private readonly data: DataService,
    private readonly csv: CsvReportGenerator,
    private readonly email: EmailService,
    private readonly options: ReportWorkerOptions,
    ids?: IdGenerator,
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {
    if (options.workerId.trim() === "") {
      throw new TypeError("workerId must be non-blank");
    }
    if (!Number.isSafeInteger(options.leaseDurationMs) || options.leaseDurationMs <= 0) {
      throw new TypeError("leaseDurationMs must be a positive safe integer");
    }
    const limit = options.attachmentLimitBytes ?? REPORT_ATTACHMENT_LIMIT_BYTES;
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("attachmentLimitBytes must be a positive safe integer");
    }
    this.attachmentLimitBytes = limit;
    this.ids = ids ?? new RandomUuidGenerator();
    this.clock = options.clock ?? new SystemClock();
  }

  async runOnce(): Promise<ReportWorkerRunResult> {
    const startedAt = performance.now();
    const claimed = await this.jobs.claimNext({
      workerId: this.options.workerId,
      leaseDurationMs: this.options.leaseDurationMs,
    });
    if (claimed === null) return { disposition: "idle" };
    this.telemetry.emit(REPORT_EVENTS.jobClaimed, {
      reportRequestId: claimed.reportRequestId,
      stage: "coordination",
      attempt: claimed.attemptCount,
      durationMs: reportDurationMs(startedAt),
    });
    return this.processClaimed(claimed);
  }
  private async processClaimed(
    claimed: ClaimedReportJob,
  ): Promise<ReportWorkerRunResult> {
    let lease: ReportJobLease = claimed;
    let context: FailureContext = "coordination";

    try {
      let evidence = await this.readEvidence(claimed.reportRequestId);
      if (evidence === null) {
        return { disposition: "stale", reportRequestId: claimed.reportRequestId };
      }
      if (isTerminal(evidence.status)) {
        return {
          disposition: "acknowledged",
          reportRequestId: claimed.reportRequestId,
        };
      }

      if (hasAcceptance(evidence)) {
        await this.reconcileAcceptance(claimed.reportRequestId, evidence);
        await this.acknowledge(lease);
        return {
          disposition: "acknowledged",
          reportRequestId: claimed.reportRequestId,
        };
      }

      assertDurableEvidenceChain(evidence);
      evidence = await this.ensureProcessing(claimed.reportRequestId, evidence);

      if (evidence.attachment === null) {
        context = "snapshot";
        let snapshot = await this.data.readSnapshot({
          reportRequestId: claimed.reportRequestId,
          userId: evidence.userId,
        });
        if (snapshot === null) {
          // A snapshot marker means the immutable rows once existed. Never
          // replace missing durable evidence by querying mutable source rows.
          if (evidence.snapshot !== null) {
            throw new ReportDomainError("unexpected_report_error");
          }
          await this.persistProgress(claimed.reportRequestId, "data_retrieval");
          snapshot = await this.data.createSnapshot({
            reportRequestId: claimed.reportRequestId,
            userId: evidence.userId,
          }, { recordFailure: false });
        }
        assertSnapshotIdentity(snapshot, claimed.reportRequestId);
        lease = await this.heartbeat(lease);

        context = "csv_generation";
        await this.persistProgress(claimed.reportRequestId, "csv_generation");
        const attachment = this.csv.generate(snapshot);
        assertAttachmentIdentity(attachment, claimed.reportRequestId);
        this.assertWithinSizeLimit(attachment.byteSize, attachment.bytes.byteLength);
        context = "attachment_persistence";
        await this.persistAttachment(attachment);
      } else {
        // The database constrains byteSize to octet_length(content). Trust the
        // immutable persisted artifact and never regenerate it on restart.
        this.assertWithinSizeLimit(
          evidence.attachment.byteSize,
          evidence.attachment.byteSize,
        );
      }
      lease = await this.heartbeat(lease);

      context = "email_submission";
      await this.persistProgress(claimed.reportRequestId, "email_submission");
      evidence = await this.readRequiredEvidence(claimed.reportRequestId);
      if (hasAcceptance(evidence)) {
        await this.reconcileAcceptance(claimed.reportRequestId, evidence);
      } else {
        assertSubmissionBeforeDeadline(evidence, this.clock.now());
        const accepted = await this.email.submit(claimed.reportRequestId);
        if (accepted === null) {
          // A concurrent terminal transition atomically completes the job.
          return {
            disposition: "acknowledged",
            reportRequestId: claimed.reportRequestId,
          };
        }
      }

      context = "acknowledgment";
      await this.acknowledge(lease);
      return {
        disposition: "acknowledged",
        reportRequestId: claimed.reportRequestId,
      };
    } catch (error) {
      if (error instanceof StaleReportJobLeaseError) {
        const current = await this.readEvidence(claimed.reportRequestId);
        return {
          disposition: current !== null && isTerminal(current.status)
            ? "acknowledged"
            : "stale",
          reportRequestId: claimed.reportRequestId,
        };
      }
      return this.handleFailure(
        claimed.reportRequestId,
        lease,
        claimed.attemptCount,
        error,
        context,
      );
    }
  }

  private async readEvidence(reportRequestId: string): Promise<RequestEvidence | null> {
    return this.prisma.reportRequest.findUnique({
      where: { id: reportRequestId },
      select: REQUEST_EVIDENCE_SELECT,
    });
  }

  private async readRequiredEvidence(reportRequestId: string): Promise<RequestEvidence> {
    const evidence = await this.readEvidence(reportRequestId);
    if (evidence === null) throw new ReportDomainError("report_not_found");
    if (isTerminal(evidence.status)) throw new StaleReportJobLeaseError();
    return evidence;
  }
  private async ensureProcessing(
    reportRequestId: string,
    evidence: RequestEvidence,
  ): Promise<RequestEvidence> {
    if (evidence.status === DbStatus.PENDING) {
      const transitioned = await this.requests.transitionNonterminal({
        reportRequestId,
        fromStatuses: ["pending"],
        toStatus: "processing",
        progressStage: evidence.snapshot === null
          ? "data_retrieval"
          : evidence.attachment === null
            ? "csv_generation"
            : "email_submission",
      });
      if (transitioned === null) throw new StaleReportJobLeaseError();
      return this.readRequiredEvidence(reportRequestId);
    }
    if (
      evidence.status !== DbStatus.PROCESSING &&
      evidence.status !== DbStatus.EMAIL_SUBMITTED
    ) {
      throw new ReportDomainError("unexpected_report_error");
    }
    if (evidence.status === DbStatus.EMAIL_SUBMITTED && evidence.attachment === null) {
      throw new ReportDomainError("unexpected_report_error");
    }
    return evidence;
  }

  private async persistProgress(
    reportRequestId: string,
    progressStage: ReportProgressStage,
  ): Promise<void> {
    const transitioned = await this.requests.transitionNonterminal({
      reportRequestId,
      fromStatuses: ["processing"],
      toStatus: "processing",
      progressStage,
    });
    if (transitioned === null) {
      const evidence = await this.readRequiredEvidence(reportRequestId);
      if (evidence.status !== DbStatus.EMAIL_SUBMITTED) {
        throw new StaleReportJobLeaseError();
      }
    }
  }

  private async reconcileAcceptance(
    reportRequestId: string,
    evidence: RequestEvidence,
  ): Promise<void> {
    if (evidence.delivery?.acceptedAt === null || evidence.delivery === null) {
      throw new ReportDomainError("unexpected_report_error");
    }
    if (evidence.status === DbStatus.EMAIL_ACCEPTED) return;
    if (evidence.status !== DbStatus.EMAIL_SUBMITTED) {
      throw new ReportDomainError("unexpected_report_error");
    }
    const transitioned = await this.requests.transitionNonterminal({
      reportRequestId,
      fromStatuses: ["email_submitted"],
      toStatus: "email_accepted",
      progressStage: "delivery_wait",
    });
    if (transitioned === null) throw new StaleReportJobLeaseError();
  }

  private async persistAttachment(attachment: ReportAttachment): Promise<void> {
    await this.prisma.reportAttachment.create({
      data: {
        id: this.ids.generate(),
        reportRequestId: attachment.reportRequestId,
        content: Buffer.from(attachment.bytes),
        byteSize: attachment.byteSize,
        sha256: attachment.sha256,
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        generatedAt: new Date(attachment.generatedAt),
      },
    });
  }

  private assertWithinSizeLimit(byteSize: number, actualByteSize: number): void {
    if (
      !Number.isSafeInteger(byteSize) ||
      byteSize < 0 ||
      byteSize !== actualByteSize
    ) {
      throw new ReportDomainError("csv_generation_failed");
    }
    if (byteSize > this.attachmentLimitBytes) {
      throw new ReportDomainError("report_too_large");
    }
  }

  private async heartbeat(lease: ReportJobLease): Promise<ReportJobLease> {
    const renewed = await this.jobs.heartbeat(
      lease,
      this.options.leaseDurationMs,
    );
    if (renewed === null) throw new StaleReportJobLeaseError();
    return renewed;
  }

  private async acknowledge(lease: ReportJobLease): Promise<void> {
    if (!(await this.jobs.complete({ lease }))) {
      throw new StaleReportJobLeaseError();
    }
  }
  private async handleFailure(
    reportRequestId: string,
    lease: ReportJobLease,
    attempt: number,
    error: unknown,
    context: FailureContext,
  ): Promise<ReportWorkerRunResult> {
    const classified = classifyFailure(error, context);
    if (classified.transient) {
      const retry = await this.jobs.scheduleRetry({
        lease,
        errorCode: classified.failure.code,
      });
      if (retry.disposition === "scheduled") {
        this.telemetry.emit(REPORT_EVENTS.jobRetried, {
          reportRequestId,
          stage: failureStage(context),
          attempt,
          disposition: "scheduled",
          errorCode: classified.failure.code,
        });
        return {
          disposition: "retry_scheduled",
          reportRequestId,
          availableAt: retry.availableAt,
        };
      }
      if (retry.disposition === "stale") {
        return { disposition: "stale", reportRequestId };
      }
    }

    await this.requests.recordFailure({
      reportRequestId,
      failure: classified.failure,
    });
    // recordFailure completes the outbox atomically. This is only a fallback for
    // a recorder implementation that persisted the request without the job.
    await this.jobs.complete({
      lease,
      errorCode: classified.failure.code,
    });
    return {
      disposition: "failed",
      reportRequestId,
      errorCode: classified.failure.code,
    };
  }
}

function failureStage(context: FailureContext): string {
  switch (context) {
    case "snapshot":
      return "snapshot";
    case "csv_generation":
    case "attachment_persistence":
      return "csv_generation";
    case "email_submission":
      return "email_submission";
    case "coordination":
    case "acknowledgment":
      return "coordination";
  }
}

function assertDurableEvidenceChain(evidence: RequestEvidence): void {
  if (evidence.attachment !== null && evidence.snapshot === null) {
    throw new ReportDomainError("unexpected_report_error");
  }
  if (evidence.delivery !== null && evidence.attachment === null) {
    throw new ReportDomainError("unexpected_report_error");
  }
  if (evidence.status === DbStatus.EMAIL_SUBMITTED && evidence.delivery === null) {
    throw new ReportDomainError("unexpected_report_error");
  }
}

function assertSubmissionBeforeDeadline(
  evidence: RequestEvidence,
  now: Date,
): void {
  if (!Number.isFinite(now.getTime())) {
    throw new ReportDomainError("unexpected_report_error");
  }
  if (evidence.delivery === null) return;

  const { submittedAt, deliveryDeadlineAt } = evidence.delivery;
  if (
    submittedAt === null ||
    deliveryDeadlineAt === null ||
    !Number.isFinite(submittedAt.getTime()) ||
    !Number.isFinite(deliveryDeadlineAt.getTime()) ||
    deliveryDeadlineAt.getTime() !==
      submittedAt.getTime() + REPORT_DELIVERY_DEADLINE_SECONDS * 1_000
  ) {
    throw new ReportDomainError("unexpected_report_error");
  }
  if (now.getTime() >= deliveryDeadlineAt.getTime()) {
    throw new ReportDomainError("delivery_timeout");
  }
}

type ClassifiedFailure = {
  readonly failure: ReportDomainError<PersistableReportFailureCode>;
  readonly transient: boolean;
};

function classifyFailure(
  error: unknown,
  context: FailureContext,
): ClassifiedFailure {
  if (isPersistableReportDomainError(error)) {
    return { failure: error, transient: error.retry === "transient" };
  }

  if (context === "csv_generation") {
    return {
      failure: new ReportDomainError("csv_generation_failed", { cause: error }),
      transient: false,
    };
  }
  if (context === "email_submission") {
    return {
      failure: new ReportDomainError("email_submission_failed", { cause: error }),
      transient: true,
    };
  }
  return {
    failure: new ReportDomainError("unexpected_report_error", { cause: error }),
    // Raw infrastructure failures are retryable. Pure CSV generation is the
    // only stage here where an unknown exception is deterministically tied to
    // immutable input and therefore permanent.
    transient: true,
  };
}

const PERSISTABLE_CODES = new Set<ReportErrorCode>([
  "data_retrieval_failed",
  "snapshot_failed",
  "csv_generation_failed",
  "missing_required_cash_amount",
  "report_too_large",
  "email_submission_failed",
  "provider_unavailable",
  "provider_rejected",
  "provider_response_invalid",
  "delivery_timeout",
  "unexpected_report_error",
]);

function isPersistableReportDomainError(
  error: unknown,
): error is ReportDomainError<PersistableReportFailureCode> {
  return isReportDomainError(error) && isPersistable(error.code);
}

function isPersistable(code: ReportErrorCode): code is PersistableReportFailureCode {
  return PERSISTABLE_CODES.has(code);
}

function isTerminal(status: DbStatus): boolean {
  return status === DbStatus.SENT || status === DbStatus.FAILED;
}

function hasAcceptance(evidence: RequestEvidence): boolean {
  return evidence.status === DbStatus.EMAIL_ACCEPTED ||
    evidence.delivery?.acceptedAt !== null && evidence.delivery !== null;
}

function assertSnapshotIdentity(
  snapshot: ReportSnapshot,
  reportRequestId: string,
): void {
  if (snapshot.reportRequestId !== reportRequestId) {
    throw new ReportDomainError("unexpected_report_error");
  }
}

function assertAttachmentIdentity(
  attachment: ReportAttachment,
  reportRequestId: string,
): void {
  if (attachment.reportRequestId !== reportRequestId) {
    throw new ReportDomainError("csv_generation_failed");
  }
}
