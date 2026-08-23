import {
  Prisma,
  PrismaClient,
  ReportFailureStage as DbFailureStage,
  ReportStatus as DbStatus,
} from "@prisma/client";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";
import type { VerifiedProviderEvent } from "./models";
import { REPORT_AUDIT_ACTIONS } from "./reportRequestService";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";

export type ProviderEventOutcome = "sent" | "failed" | "ignored";

export interface ProviderEventProcessingResult {
  readonly disposition: "stored" | "duplicate";
  readonly outcome: ProviderEventOutcome;
}

type Transaction = Prisma.TransactionClient;

/**
 * Durably stores verified provider events and applies terminal transitions in
 * the same database transaction. Events that cannot change state are retained.
 */
export class ProviderEventProcessor {
  private readonly clock: Clock;

  constructor(
    private readonly prisma: PrismaClient,
    clock: Clock = new SystemClock(),
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {
    this.clock = clock;
  }

  async process(
    event: VerifiedProviderEvent,
  ): Promise<ProviderEventProcessingResult> {
    const startedAt = performance.now();
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.providerEvent.create({ data: event });
        const delivery = await tx.reportDelivery.findUnique({
          where: { providerMessageId: event.providerMessageId },
          include: { reportRequest: true },
        });
        if (delivery === null) {
          this.telemetry.emit(REPORT_EVENTS.webhookIgnored, {
            providerEventId: event.providerEventId,
            providerMessageId: event.providerMessageId,
            eventType: event.eventType,
            disposition: "unknown_message",
            durationMs: reportDurationMs(startedAt),
          });
          return stored("ignored");
        }

        const result = event.eventType === "delivered"
          ? await this.applyDelivery(tx, delivery, event)
          : await this.applyRejection(tx, delivery, event);
        this.telemetry.emit(
          result.outcome === "ignored"
            ? REPORT_EVENTS.webhookIgnored
            : REPORT_EVENTS.webhookApplied,
          {
            reportRequestId: delivery.reportRequest.id,
            userId: delivery.reportRequest.userId,
            providerEventId: event.providerEventId,
            providerMessageId: event.providerMessageId,
            eventType: event.eventType,
            disposition: result.outcome,
            statusTo: result.outcome === "sent" || result.outcome === "failed"
              ? result.outcome
              : undefined,
            stage: "webhook",
            durationMs: reportDurationMs(startedAt),
            confirmationLatencyMs:
              result.outcome === "sent" && delivery.acceptedAt !== null
                ? Math.max(0, event.occurredAt.getTime() - delivery.acceptedAt.getTime())
                : undefined,
          },
        );
        if (result.outcome === "sent" || result.outcome === "failed") {
          this.telemetry.emit(REPORT_EVENTS.terminalTransition, {
            reportRequestId: delivery.reportRequest.id,
            userId: delivery.reportRequest.userId,
            statusFrom: delivery.reportRequest.status.toLowerCase(),
            statusTo: result.outcome,
            stage: "email_submission",
            errorCode: result.outcome === "failed" ? "provider_rejected" : undefined,
          });
        }
        return result;
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        this.telemetry.emit(REPORT_EVENTS.webhookDeduplicated, {
          providerEventId: event.providerEventId,
          providerMessageId: event.providerMessageId,
          eventType: event.eventType,
          disposition: "duplicate",
          durationMs: reportDurationMs(startedAt),
        });
        return { disposition: "duplicate", outcome: "ignored" };
      }
      throw error;
    }
  }

  private async applyDelivery(
    tx: Transaction,
    delivery: DeliveryWithRequest,
    event: VerifiedProviderEvent,
  ): Promise<ProviderEventProcessingResult> {
    const request = delivery.reportRequest;
    if (
      request.status !== DbStatus.EMAIL_ACCEPTED ||
      delivery.acceptedAt === null ||
      delivery.confirmedAt !== null
    ) {
      return stored("ignored");
    }

    const requestUpdate = await tx.reportRequest.updateMany({
      where: { id: request.id, status: DbStatus.EMAIL_ACCEPTED },
      data: {
        status: DbStatus.SENT,
        progressStage: "delivery_wait",
        sentAt: event.occurredAt,
      },
    });
    if (requestUpdate.count === 0) {
      return stored("ignored");
    }

    const deliveryUpdate = await tx.reportDelivery.updateMany({
      where: {
        id: delivery.id,
        acceptedAt: { not: null },
        confirmedAt: null,
      },
      data: { confirmedAt: event.occurredAt },
    });
    if (deliveryUpdate.count !== 1) {
      throw new Error("Provider delivery transition lost atomicity.");
    }

    await completeJob(tx, request.id, this.clock.now(), null);
    await writeTerminalAudit(tx, request, "sent");
    return stored("sent");
  }

  private async applyRejection(
    tx: Transaction,
    delivery: DeliveryWithRequest,
    _event: VerifiedProviderEvent,
  ): Promise<ProviderEventProcessingResult> {
    const request = delivery.reportRequest;
    if (
      delivery.confirmedAt !== null ||
      (request.status !== DbStatus.EMAIL_SUBMITTED &&
        request.status !== DbStatus.EMAIL_ACCEPTED)
    ) {
      return stored("ignored");
    }

    const requestUpdate = await tx.reportRequest.updateMany({
      where: { id: request.id, status: request.status },
      data: {
        status: DbStatus.FAILED,
        progressStage: "email_submission",
        failureStage: DbFailureStage.EMAIL_SUBMISSION,
        failureCode: "provider_rejected",
      },
    });
    if (requestUpdate.count === 0) {
      return stored("ignored");
    }

    await completeJob(
      tx,
      request.id,
      this.clock.now(),
      "provider_rejected",
    );
    await writeTerminalAudit(tx, request, "failed", {
      failureStage: "email_submission",
      failureCode: "provider_rejected",
    });
    return stored("failed");
  }
}

type DeliveryWithRequest = Prisma.ReportDeliveryGetPayload<{
  include: { reportRequest: true };
}>;

function stored(outcome: ProviderEventOutcome): ProviderEventProcessingResult {
  return { disposition: "stored", outcome };
}

async function completeJob(
  tx: Transaction,
  reportRequestId: string,
  completedAt: Date,
  lastErrorCode: string | null,
): Promise<void> {
  await tx.reportJob.updateMany({
    where: { reportRequestId, completedAt: null },
    data: {
      completedAt,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode,
    },
  });
}

async function writeTerminalAudit(
  tx: Transaction,
  request: DeliveryWithRequest["reportRequest"],
  statusTo: "sent" | "failed",
  extra: Record<string, string> = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: request.userId,
      action: REPORT_AUDIT_ACTIONS.terminal,
      entityType: "ReportRequest",
      entityId: request.id,
      changes: {
        statusFrom: request.status.toLowerCase(),
        statusTo,
        ...extra,
      },
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError ||
    (typeof error === "object" && error !== null && "code" in error)
  ) && error.code === "P2002";
}
