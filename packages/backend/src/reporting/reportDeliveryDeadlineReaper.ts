import {
  Prisma,
  PrismaClient,
  ReportStatus as DbStatus,
} from "@prisma/client";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";
import { REPORT_AUDIT_ACTIONS } from "./reportRequestService";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";

const DEFAULT_BATCH_SIZE = 100;
const TIMEOUT_CODE = "delivery_timeout" as const;

export interface DeliveryDeadlineReaperOptions {
  readonly batchSize?: number;
}

export interface DeliveryDeadlineSweepResult {
  readonly timedOutCount: number;
  readonly reportRequestIds: readonly string[];
}

type Transaction = Prisma.TransactionClient;
type TimedOutRow = {
  id: string;
  user_id: string;
  status_from: "EMAIL_SUBMITTED" | "EMAIL_ACCEPTED";
};

/**
 * Fails submitted report emails that have reached their durable delivery
 * deadline. Row locks and compare-and-set predicates make concurrent sweepers
 * and provider confirmations resolve to exactly one terminal transition.
 */
export class ReportDeliveryDeadlineReaper {
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = new SystemClock(),
    options: DeliveryDeadlineReaperOptions = {},
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {
    this.batchSize = positiveInteger(
      options.batchSize ?? DEFAULT_BATCH_SIZE,
      "batchSize",
    );
  }

  async sweep(): Promise<DeliveryDeadlineSweepResult> {
    const now = validInstant(this.clock.now());
    const startedAt = performance.now();
    const result = await this.prisma.$transaction(async (tx) => {
      const timedOut = await failDueRequests(tx, now, this.batchSize);
      if (timedOut.length === 0) return emptyResult();

      const reportRequestIds = timedOut.map((row) => row.id);
      await completeJobs(tx, reportRequestIds, now);
      await writeAudits(tx, timedOut);
      return { timedOutCount: timedOut.length, reportRequestIds };
    });
    for (const reportRequestId of result.reportRequestIds) {
      this.telemetry.emit(REPORT_EVENTS.deadlineFailure, {
        reportRequestId,
        stage: "email_submission",
        statusTo: "failed",
        errorCode: TIMEOUT_CODE,
        durationMs: reportDurationMs(startedAt),
        timedOutCount: result.timedOutCount,
      });
      this.telemetry.emit(REPORT_EVENTS.terminalTransition, {
        reportRequestId,
        statusTo: "failed",
        stage: "email_submission",
        errorCode: TIMEOUT_CODE,
      });
    }
    return result;
  }
}
async function failDueRequests(
  tx: Transaction,
  now: Date,
  batchSize: number,
): Promise<TimedOutRow[]> {
  return tx.$queryRaw<TimedOutRow[]>(Prisma.sql`
    WITH candidate AS (
      SELECT request."id",
             request."user_id",
             request."status" AS status_from
      FROM "report_requests" AS request
      INNER JOIN "report_deliveries" AS delivery
        ON delivery."report_request_id" = request."id"
      WHERE request."status" IN (
          CAST('EMAIL_SUBMITTED' AS "ReportStatus"),
          CAST('EMAIL_ACCEPTED' AS "ReportStatus")
        )
        AND delivery."submitted_at" IS NOT NULL
        AND delivery."delivery_deadline_at" IS NOT NULL
        AND delivery."delivery_deadline_at" <= ${now}
        AND delivery."confirmed_at" IS NULL
      ORDER BY delivery."delivery_deadline_at" ASC, request."id" ASC
      FOR UPDATE OF request, delivery SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "report_requests" AS request
    SET "status" = CAST('FAILED' AS "ReportStatus"),
        "progress_stage" = 'email_submission',
        "failure_stage" = CAST('EMAIL_SUBMISSION' AS "ReportFailureStage"),
        "failure_code" = ${TIMEOUT_CODE},
        "updated_at" = ${now}
    FROM candidate
    WHERE request."id" = candidate."id"
      AND request."status" = candidate.status_from
      AND EXISTS (
        SELECT 1
        FROM "report_deliveries" AS delivery
        WHERE delivery."report_request_id" = request."id"
          AND delivery."delivery_deadline_at" <= ${now}
          AND delivery."confirmed_at" IS NULL
      )
    RETURNING request."id", request."user_id", candidate.status_from
  `);
}

async function completeJobs(
  tx: Transaction,
  reportRequestIds: readonly string[],
  now: Date,
): Promise<void> {
  await tx.reportJob.updateMany({
    where: {
      reportRequestId: { in: [...reportRequestIds] },
      completedAt: null,
    },
    data: {
      completedAt: now,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorCode: TIMEOUT_CODE,
    },
  });
}

async function writeAudits(
  tx: Transaction,
  timedOut: readonly TimedOutRow[],
): Promise<void> {
  for (const row of timedOut) {
    await tx.auditLog.create({
      data: {
        userId: row.user_id,
        action: REPORT_AUDIT_ACTIONS.terminal,
        entityType: "ReportRequest",
        entityId: row.id,
        changes: {
          statusFrom: fromDbStatus(row.status_from),
          statusTo: "failed",
          failureStage: "email_submission",
          failureCode: TIMEOUT_CODE,
        },
      },
    });
  }
}

function fromDbStatus(
  status: TimedOutRow["status_from"],
): "email_submitted" | "email_accepted" {
  return status === DbStatus.EMAIL_ACCEPTED
    ? "email_accepted"
    : "email_submitted";
}

function emptyResult(): DeliveryDeadlineSweepResult {
  return { timedOutCount: 0, reportRequestIds: [] };
}

function validInstant(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value.getTime());
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}
