import {
  Prisma,
  PrismaClient,
  ReportStatus as DbStatus,
  ReportType as DbReportType,
} from "@prisma/client";
import { REPORT_CSV_MEDIA_TYPE, type ReportType } from "./constants";
import { ReportDomainError } from "./errors";
import type { Clock, IdGenerator } from "./infrastructure";
import { RandomUuidGenerator } from "./infrastructure";
import {
  REPORT_EVENTS,
  hashReportEmail,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";
import type { EmailProviderCommand } from "./provider";
import {
  isEmailProviderSubmissionError,
  type EmailProvider,
  type EmailProviderAcceptance,
} from "./provider";
import type { RecordReportFailureInput } from "./reportRequestService";

export const REPORT_EMAIL_SUBJECT_LIMIT = 200 as const;
export const REPORT_EMAIL_BODY_LIMIT = 2_000 as const;
export const REPORT_DELIVERY_DEADLINE_SECONDS = 300 as const;

const SUBMISSION_SELECT = {
  id: true,
  accountEmail: true,
  reportType: true,
  periodStart: true,
  periodEnd: true,
  status: true,
  sentAt: true,
  snapshot: {
    select: {
      recordCount: true,
      digitalIncomeTotal: true,
      cashIncomeTotal: true,
      halalIncomeTotal: true,
      nonHalalIncomeTotal: true,
    },
  },
  attachment: {
    select: { content: true, filename: true, mediaType: true },
  },
  delivery: true,
} as const satisfies Prisma.ReportRequestSelect;
type SubmissionRow = Prisma.ReportRequestGetPayload<{
  select: typeof SUBMISSION_SELECT;
}>;
type PersistedDelivery = NonNullable<SubmissionRow["delivery"]>;
type Transaction = Prisma.TransactionClient;

type FailureRecorder = {
  recordFailure(input: RecordReportFailureInput): Promise<unknown>;
};

interface PreparedSubmission {
  readonly command: EmailProviderCommand;
  readonly submittedAt: Date;
  readonly deliveryDeadlineAt: Date;
}

export interface ReportEmailSubmissionResult {
  readonly disposition: "accepted" | "already_accepted";
  readonly status: "email_accepted";
  readonly providerMessageId: string;
  readonly submittedAt: Date;
  readonly acceptedAt: Date;
  readonly deliveryDeadlineAt: Date;
}

/**
 * Constructs and submits report email commands only from durable report rows.
 * Provider acceptance remains EMAIL_ACCEPTED; only a delivery event may set SENT.
 */
export class ReportEmailService {
  private readonly ids: IdGenerator;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly provider: EmailProvider,
    private readonly clock: Clock,
    private readonly failureRecorder: FailureRecorder,
    ids?: IdGenerator,
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {
    this.ids = ids ?? new RandomUuidGenerator();
  }

  async submit(
    reportRequestId: string,
  ): Promise<ReportEmailSubmissionResult | null> {
    const prepared = await this.prepareSubmission(reportRequestId);
    if (prepared === null) {
      return null;
    }
    if ("status" in prepared) {
      return prepared;
    }

    const startedAt = performance.now();
    this.telemetry.emit(REPORT_EVENTS.providerSubmissionAttempted, {
      reportRequestId,
      stage: "email_submission",
      emailHash: hashReportEmail(prepared.command.to[0]),
    });
    let acceptance: EmailProviderAcceptance;
    try {
      acceptance = await this.provider.submit(prepared.command);
    } catch (error) {
      if (isEmailProviderSubmissionError(error) && error.definitive) {
        const failure = new ReportDomainError("provider_rejected", {
          cause: error,
        });
        this.telemetry.emit(REPORT_EVENTS.providerSubmissionRejected, {
          reportRequestId,
          stage: "email_submission",
          durationMs: reportDurationMs(startedAt),
          errorCode: failure.code,
          emailHash: hashReportEmail(prepared.command.to[0]),
        });
        await this.persistDefinitiveFailure(reportRequestId, failure);
        throw failure;
      }
      const failure = providerFailure(error);
      this.telemetry.emit(REPORT_EVENTS.providerSubmissionRejected, {
        reportRequestId,
        stage: "email_submission",
        durationMs: reportDurationMs(startedAt),
        errorCode: failure.code,
        emailHash: hashReportEmail(prepared.command.to[0]),
      });
      throw failure;
    }

    validateAcceptance(acceptance, prepared.submittedAt);
    this.telemetry.emit(REPORT_EVENTS.providerSubmissionAccepted, {
      reportRequestId,
      stage: "email_submission",
      durationMs: reportDurationMs(startedAt),
      providerMessageId: acceptance.providerMessageId,
      emailHash: hashReportEmail(prepared.command.to[0]),
    });
    return this.persistAcceptance(reportRequestId, acceptance);
  }

  private prepareSubmission(
    reportRequestId: string,
  ): Promise<PreparedSubmission | ReportEmailSubmissionResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.reportRequest.findUnique({
        where: { id: reportRequestId },
        select: SUBMISSION_SELECT,
      });
      if (request === null) {
        throw new ReportDomainError("report_not_found");
      }
      if (request.status === DbStatus.SENT || request.status === DbStatus.FAILED) {
        return null;
      }
      if (request.status === DbStatus.EMAIL_ACCEPTED) {
        return existingAcceptance(request.delivery);
      }
      if (
        request.status !== DbStatus.PROCESSING &&
        request.status !== DbStatus.EMAIL_SUBMITTED
      ) {
        throw new ReportDomainError("email_submission_failed");
      }

      const commandParts = buildCommandParts(request);
      const delivery = await this.ensureSubmittedDelivery(
        tx,
        request,
        reportRequestId,
      );
      if (request.status === DbStatus.PROCESSING) {
        const transitioned = await tx.reportRequest.updateMany({
          where: { id: reportRequestId, status: DbStatus.PROCESSING },
          data: {
            status: DbStatus.EMAIL_SUBMITTED,
            progressStage: "email_submission",
          },
        });
        if (transitioned.count === 0) {
          return null;
        }
      }

      return {
        command: {
          idempotencyKey: delivery.idempotencyKey,
          to: [request.accountEmail],
          subject: commandParts.subject,
          textBody: commandParts.textBody,
          attachment: commandParts.attachment,
        },
        submittedAt: cloneDate(requireDate(delivery.submittedAt)),
        deliveryDeadlineAt: cloneDate(
          requireDate(delivery.deliveryDeadlineAt),
        ),
      };
    });
  }

  private async ensureSubmittedDelivery(
    tx: Transaction,
    request: SubmissionRow,
    reportRequestId: string,
  ): Promise<PersistedDelivery> {
    const expectedKey = idempotencyKey(reportRequestId);
    if (request.delivery !== null) {
      if (request.delivery.idempotencyKey !== expectedKey) {
        throw new ReportDomainError("unexpected_report_error");
      }
      if (request.delivery.acceptedAt !== null) {
        return request.delivery;
      }
      if (request.delivery.submittedAt !== null) {
        assertExactDeadline(request.delivery);
        return request.delivery;
      }

      const submittedAt = validClockInstant(this.clock.now());
      return tx.reportDelivery.update({
        where: { reportRequestId },
        data: {
          submittedAt,
          deliveryDeadlineAt: deadlineFrom(submittedAt),
        },
      });
    }

    const submittedAt = validClockInstant(this.clock.now());
    return tx.reportDelivery.create({
      data: {
        id: this.ids.generate(),
        reportRequestId,
        idempotencyKey: expectedKey,
        submittedAt,
        deliveryDeadlineAt: deadlineFrom(submittedAt),
      },
    });
  }

  private persistAcceptance(
    reportRequestId: string,
    acceptance: EmailProviderAcceptance,
  ): Promise<ReportEmailSubmissionResult | null> {
    return this.prisma.$transaction(async (tx) => {
      const request = await tx.reportRequest.findUnique({
        where: { id: reportRequestId },
        select: { status: true, delivery: true },
      });
      if (request === null) {
        throw new ReportDomainError("report_not_found");
      }
      if (request.status === DbStatus.SENT || request.status === DbStatus.FAILED) {
        return null;
      }
      if (request.delivery === null) {
        throw new ReportDomainError("unexpected_report_error");
      }
      if (request.delivery.acceptedAt !== null) {
        return existingAcceptance(request.delivery);
      }

      const transitioned = await tx.reportRequest.updateMany({
        where: { id: reportRequestId, status: DbStatus.EMAIL_SUBMITTED },
        data: {
          status: DbStatus.EMAIL_ACCEPTED,
          progressStage: "delivery_wait",
        },
      });
      if (transitioned.count === 0) {
        const current = await tx.reportRequest.findUnique({
          where: { id: reportRequestId },
          select: { status: true, delivery: true },
        });
        return current?.status === DbStatus.EMAIL_ACCEPTED
          ? existingAcceptance(current.delivery)
          : null;
      }

      const recorded = await tx.reportDelivery.updateMany({
        where: { reportRequestId, acceptedAt: null },
        data: {
          providerMessageId: acceptance.providerMessageId,
          acceptedAt: cloneDate(acceptance.acceptedAt),
        },
      });
      if (recorded.count !== 1) {
        throw new ReportDomainError("unexpected_report_error");
      }
      const delivery = await tx.reportDelivery.findUnique({
        where: { reportRequestId },
      });
      if (delivery === null) {
        throw new ReportDomainError("unexpected_report_error");
      }
      return acceptanceResult(delivery, "accepted");
    });
  }

  private async persistDefinitiveFailure(
    reportRequestId: string,
    failure: ReportDomainError<"provider_rejected">,
  ): Promise<void> {
    try {
      await this.failureRecorder.recordFailure({
        reportRequestId,
        failure,
        fromStatuses: ["email_submitted", "email_accepted"],
      });
    } catch (error) {
      throw new ReportDomainError("provider_rejected", { cause: error });
    }
  }
}

function buildCommandParts(request: SubmissionRow): Pick<
  EmailProviderCommand,
  "subject" | "textBody" | "attachment"
> {
  if (request.snapshot === null || request.attachment === null) {
    throw new ReportDomainError("email_submission_failed");
  }
  if (request.attachment.mediaType !== REPORT_CSV_MEDIA_TYPE) {
    throw new ReportDomainError("email_submission_failed");
  }

  const reportType = fromDbReportType(request.reportType);
  const periodStart = databaseDate(request.periodStart);
  const periodEnd = databaseDate(request.periodEnd);
  const subject = `${titleCase(reportType)} Report: ${periodStart} to ${periodEnd}`;
  const summary = request.snapshot;
  const textBody = [
    `Report Type: ${reportType}`,
    `Period Start: ${periodStart}`,
    `Period End: ${periodEnd}`,
    `Delivery Record Count: ${summary.recordCount}`,
    `Digital Income Total: ${summary.digitalIncomeTotal.toFixed(2)}`,
    `Cash Income Total: ${summary.cashIncomeTotal.toFixed(2)}`,
    `Halal Income Total: ${summary.halalIncomeTotal.toFixed(2)}`,
    `Non-Halal Income Total: ${summary.nonHalalIncomeTotal.toFixed(2)}`,
  ].join("\n");

  if (subject.length > REPORT_EMAIL_SUBJECT_LIMIT) {
    throw new ReportDomainError("email_submission_failed");
  }
  if (textBody.length > REPORT_EMAIL_BODY_LIMIT) {
    throw new ReportDomainError("email_submission_failed");
  }

  return {
    subject,
    textBody,
    attachment: {
      filename: request.attachment.filename,
      mediaType: REPORT_CSV_MEDIA_TYPE,
      bytes: new Uint8Array(request.attachment.content),
    },
  };
}

function existingAcceptance(
  delivery: PersistedDelivery | null,
): ReportEmailSubmissionResult {
  if (
    delivery === null ||
    delivery.providerMessageId === null ||
    delivery.acceptedAt === null
  ) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return acceptanceResult(delivery, "already_accepted");
}

function acceptanceResult(
  delivery: PersistedDelivery,
  disposition: ReportEmailSubmissionResult["disposition"],
): ReportEmailSubmissionResult {
  assertExactDeadline(delivery);
  return {
    disposition,
    status: "email_accepted",
    providerMessageId: requireNonblank(delivery.providerMessageId),
    submittedAt: cloneDate(requireDate(delivery.submittedAt)),
    acceptedAt: cloneDate(requireDate(delivery.acceptedAt)),
    deliveryDeadlineAt: cloneDate(requireDate(delivery.deliveryDeadlineAt)),
  };
}

function validateAcceptance(
  acceptance: EmailProviderAcceptance,
  submittedAt: Date,
): void {
  if (
    acceptance.providerMessageId.trim().length === 0 ||
    !Number.isFinite(acceptance.acceptedAt.getTime()) ||
    acceptance.acceptedAt.getTime() < submittedAt.getTime()
  ) {
    throw new ReportDomainError("provider_response_invalid");
  }
}

function providerFailure(error: unknown): ReportDomainError<
  | "provider_rejected"
  | "provider_unavailable"
  | "provider_response_invalid"
  | "email_submission_failed"
> {
  if (!isEmailProviderSubmissionError(error)) {
    return new ReportDomainError("email_submission_failed", { cause: error });
  }
  switch (error.kind) {
    case "rejected":
      return new ReportDomainError("provider_rejected", { cause: error });
    case "unavailable":
      return new ReportDomainError("provider_unavailable", { cause: error });
    case "invalid_response":
      return new ReportDomainError("provider_response_invalid", {
        cause: error,
      });
  }
}

function idempotencyKey(reportRequestId: string): string {
  return `report:${reportRequestId}`;
}

function deadlineFrom(submittedAt: Date): Date {
  return new Date(
    submittedAt.getTime() + REPORT_DELIVERY_DEADLINE_SECONDS * 1_000,
  );
}

function assertExactDeadline(delivery: PersistedDelivery): void {
  const submittedAt = requireDate(delivery.submittedAt);
  const deadline = requireDate(delivery.deliveryDeadlineAt);
  if (deadline.getTime() !== deadlineFrom(submittedAt).getTime()) {
    throw new ReportDomainError("unexpected_report_error");
  }
}

function validClockInstant(value: Date): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return cloneDate(value);
}

function requireDate(value: Date | null): Date {
  if (value === null || !Number.isFinite(value.getTime())) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return value;
}

function requireNonblank(value: string | null): string {
  if (value === null || value.trim().length === 0) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return value;
}

function cloneDate(value: Date): Date {
  return new Date(value.getTime());
}

function databaseDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return value.toISOString().slice(0, 10);
}

function titleCase(value: ReportType): "Weekly" | "Monthly" {
  return value === "weekly" ? "Weekly" : "Monthly";
}

function fromDbReportType(value: DbReportType): ReportType {
  return value === DbReportType.WEEKLY ? "weekly" : "monthly";
}
