import {
  Prisma,
  PrismaClient,
  ReportFailureStage as DbFailureStage,
  ReportStatus as DbStatus,
  ReportType as DbType,
} from "@prisma/client";
import type {
  CreateReportRequestCommand,
  RetryReportRequestCommand,
} from "./commands";
import {
  REPORT_ERROR_CODES,
  ReportDomainError,
  ReportInProgressError,
  type ReportErrorCode,
} from "./errors";
import type { ReportRequestDto } from "./dtos";
import type {
  ReportFailureStage,
  ReportProgressStage,
  ReportStatus,
  ReportType,
} from "./constants";
import { isTerminalReportStatus } from "./constants";
import type { Clock, IdGenerator } from "./infrastructure";
import { RandomUuidGenerator } from "./infrastructure";
import {
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  type ReportTelemetry,
} from "./observability";
import { ReportPeriodResolver } from "./reportPeriodResolver";
import { PostgresReportJobRepository } from "./reportJobRepository";
import {
  asReportDateString,
  formatUtcTimestamp,
  type ReportDateString,
} from "./temporal";

const REQUEST_INCLUDE = {
  delivery: { select: { acceptedAt: true } },
} as const satisfies Prisma.ReportRequestInclude;

type RequestRow = Prisma.ReportRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;
type Transaction = Prisma.TransactionClient;
const NONTERMINAL_STATUSES = [
  "pending",
  "processing",
  "email_submitted",
  "email_accepted",
] as const satisfies readonly ReportStatus[];
type NonterminalStatus = (typeof NONTERMINAL_STATUSES)[number];

const PERSISTABLE_FAILURE_CODES = [
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
] as const satisfies readonly ReportErrorCode[];
export type PersistableReportFailureCode =
  (typeof PERSISTABLE_FAILURE_CODES)[number];

export interface ReportRequestMutationResult {
  readonly disposition: "created" | "replayed";
  readonly request: ReportRequestDto;
}

export interface TransitionReportRequestInput {
  readonly reportRequestId: string;
  readonly fromStatuses: readonly NonterminalStatus[];
  readonly toStatus: NonterminalStatus;
  readonly progressStage: ReportProgressStage;
}

export interface RecordReportFailureInput {
  readonly reportRequestId: string;
  readonly failure: ReportDomainError<PersistableReportFailureCode>;
  readonly fromStatuses?: readonly NonterminalStatus[];
  readonly failedAt?: Date;
}

export interface MarkReportSentInput {
  readonly reportRequestId: string;
  readonly confirmedAt?: Date;
}

interface AttemptInput {
  readonly userId: string;
  readonly clientRequestId: string;
  readonly reportType?: ReportType;
  readonly referenceDate?: ReportDateString;
  readonly retryOfId: string | null;
}

export const REPORT_AUDIT_ACTIONS = Object.freeze({
  created: "report_request.created",
  retried: "report_request.retried",
  terminal: "report_request.terminal",
} as const);
export class ReportRequestService {
  private readonly ids: IdGenerator;
  private readonly jobs: PostgresReportJobRepository;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly periodResolver: ReportPeriodResolver,
    private readonly clock: Clock,
    ids?: IdGenerator,
    jobs?: PostgresReportJobRepository,
    private readonly telemetry: ReportTelemetry = reportTelemetry,
  ) {
    this.ids = ids ?? new RandomUuidGenerator();
    this.jobs = jobs ?? new PostgresReportJobRepository(
      prisma,
      clock,
      this.ids,
    );
  }

  async create(
    command: CreateReportRequestCommand,
  ): Promise<ReportRequestMutationResult> {
    validateClientRequestId(command.clientRequestId);
    const startedAt = performance.now();
    try {
      const result = await this.createAttempt({
        userId: command.userId,
        clientRequestId: command.clientRequestId,
        reportType: command.reportType,
        referenceDate: command.referenceDate,
        retryOfId: null,
      });
      this.telemetry.emit(
        result.disposition === "created"
          ? REPORT_EVENTS.requestCreated
          : REPORT_EVENTS.requestDeduplicated,
        {
          reportRequestId: result.request.id,
          userId: command.userId,
          statusTo: result.request.status,
          disposition: result.disposition,
          operation: "create",
          durationMs: reportDurationMs(startedAt),
        },
      );
      return result;
    } catch (error) {
      this.emitAttemptBlocked(command.userId, "create", error, startedAt);
      throw error;
    }
  }

  async retry(
    command: RetryReportRequestCommand,
  ): Promise<ReportRequestMutationResult> {
    validateClientRequestId(command.clientRequestId);
    const startedAt = performance.now();
    try {
      const result = await this.createAttempt({
        userId: command.userId,
        clientRequestId: command.clientRequestId,
        retryOfId: command.reportRequestId,
      });
      this.telemetry.emit(
        result.disposition === "created"
          ? REPORT_EVENTS.retryCreated
          : REPORT_EVENTS.requestDeduplicated,
        {
          reportRequestId: result.request.id,
          userId: command.userId,
          statusTo: result.request.status,
          disposition: result.disposition,
          operation: "retry",
          durationMs: reportDurationMs(startedAt),
        },
      );
      return result;
    } catch (error) {
      this.emitAttemptBlocked(command.userId, "retry", error, startedAt);
      throw error;
    }
  }

  async getActiveRequest(userId: string): Promise<ReportRequestDto | null> {
    const row = await this.prisma.reportRequest.findFirst({
      where: { userId, status: { notIn: DB_TERMINAL_STATUSES } },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: REQUEST_INCLUDE,
    });
    return row === null ? null : toDto(row);
  }

  async getOwnedRequest(
    userId: string,
    reportRequestId: string,
  ): Promise<ReportRequestDto | null> {
    const row = await this.prisma.reportRequest.findFirst({
      where: { id: reportRequestId, userId },
      include: REQUEST_INCLUDE,
    });
    return row === null ? null : toDto(row);
  }

  private async createAttempt(
    input: AttemptInput,
  ): Promise<ReportRequestMutationResult> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.createAttemptInTransaction(tx, input),
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      return this.classifyCreateRace(input);
    }
  }

  private async createAttemptInTransaction(
    tx: Transaction,
    input: AttemptInput,
  ): Promise<ReportRequestMutationResult> {
    const user = await tx.user.findUnique({
      where: { id: input.userId },
      select: { id: true, email: true, timeZone: true },
    });
    if (user === null) {
      throw new ReportDomainError("authentication_required");
    }

    const rawSelection = input.retryOfId === null
      ? {
          reportType: input.reportType,
          referenceDate: input.referenceDate,
        }
      : await loadRetrySelection(tx, input.userId, input.retryOfId);
    const resolved = this.periodResolver.resolve({
      reportType: rawSelection.reportType,
      referenceDate: rawSelection.referenceDate,
      timeZone: user.timeZone,
    });
    const selection = {
      reportType: resolved.reportType,
      referenceDate: resolved.referenceDate,
    };
    const existing = await tx.reportRequest.findUnique({
      where: {
        userId_clientRequestId: {
          userId: input.userId,
          clientRequestId: input.clientRequestId,
        },
      },
      include: REQUEST_INCLUDE,
    });
    if (existing !== null) {
      return classifyExisting(existing, input, selection);
    }

    const active = await tx.reportRequest.findFirst({
      where: { userId: input.userId, status: { notIn: DB_TERMINAL_STATUSES } },
      include: REQUEST_INCLUDE,
    });
    if (active !== null) {
      throw new ReportInProgressError(toDto(active));
    }
    const now = this.clock.now();
    const request = await tx.reportRequest.create({
      data: {
        id: this.ids.generate(),
        userId: user.id,
        clientRequestId: input.clientRequestId,
        retryOfId: input.retryOfId,
        reportType: TO_DB_TYPE[resolved.reportType],
        referenceDate: toDatabaseDate(resolved.referenceDate),
        periodStart: toDatabaseDate(resolved.period.startDate),
        periodEnd: toDatabaseDate(resolved.period.endDate),
        accountEmail: user.email,
        timeZone: user.timeZone,
        status: DbStatus.PENDING,
        progressStage: "data_retrieval",
      },
      include: REQUEST_INCLUDE,
    });
    await this.jobs.enqueueInTransaction(tx, {
      id: this.ids.generate(),
      reportRequestId: request.id,
      availableAt: now,
    });

    await tx.auditLog.create({
      data: {
        userId: user.id,
        action: input.retryOfId === null
          ? REPORT_AUDIT_ACTIONS.created
          : REPORT_AUDIT_ACTIONS.retried,
        entityType: "ReportRequest",
        entityId: request.id,
        changes: auditChanges({
          status: "pending",
          reportType: resolved.reportType,
          retryOfId: input.retryOfId,
        }),
      },
    });
    return { disposition: "created", request: toDto(request) };
  }
  private async classifyCreateRace(
    input: AttemptInput,
  ): Promise<ReportRequestMutationResult> {
    const existing = await this.prisma.reportRequest.findUnique({
      where: {
        userId_clientRequestId: {
          userId: input.userId,
          clientRequestId: input.clientRequestId,
        },
      },
      include: REQUEST_INCLUDE,
    });
    if (existing !== null) {
      const selection = input.retryOfId === null
        ? requireCreateSelection(input)
        : {
            reportType: FROM_DB_TYPE[existing.reportType],
            referenceDate: fromDatabaseDate(existing.referenceDate),
          };
      return classifyExisting(existing, input, selection);
    }

    const active = await this.prisma.reportRequest.findFirst({
      where: { userId: input.userId, status: { notIn: DB_TERMINAL_STATUSES } },
      include: REQUEST_INCLUDE,
    });
    if (active !== null) {
      throw new ReportInProgressError(toDto(active));
    }
    throw new ReportDomainError("unexpected_report_error");
  }

  async transitionNonterminal(
    input: TransitionReportRequestInput,
  ): Promise<ReportRequestDto | null> {
    if (input.fromStatuses.length === 0) {
      return null;
    }
    if (isTerminalReportStatus(input.toStatus)) {
      throw new TypeError("Use a terminal transition operation for terminal states");
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.reportRequest.updateMany({
        where: {
          id: input.reportRequestId,
          status: { in: input.fromStatuses.map(toDbStatus) },
        },
        data: {
          status: toDbStatus(input.toStatus),
          progressStage: input.progressStage,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      const row = await tx.reportRequest.findUnique({
        where: { id: input.reportRequestId },
        include: REQUEST_INCLUDE,
      });
      return row === null ? null : toDto(row);
    });
  }

  async recordFailure(
    input: RecordReportFailureInput,
  ): Promise<ReportRequestDto | null> {
    const stage = input.failure.stage;
    if (stage === undefined || !PERSISTABLE_FAILURE_CODES.includes(input.failure.code)) {
      throw new TypeError("Only typed report processing failures can be persisted");
    }
    const failedAt = input.failedAt ?? this.clock.now();
    const fromStatuses = input.fromStatuses ?? NONTERMINAL_STATUSES;

    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.reportRequest.findFirst({
        where: {
          id: input.reportRequestId,
          status: { in: fromStatuses.map(toDbStatus) },
        },
        include: REQUEST_INCLUDE,
      });
      if (candidate === null) {
        return null;
      }
      const updated = await tx.reportRequest.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: DbStatus.FAILED,
          progressStage: failureProgressStage(stage, candidate.progressStage),
          failureStage: TO_DB_FAILURE_STAGE[stage],
          failureCode: input.failure.code,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      await completeJob(tx, candidate.id, failedAt, input.failure.code);
      await writeTerminalAudit(tx, candidate, "failed", {
        failureStage: stage,
        failureCode: input.failure.code,
      });
      this.telemetry.emit(REPORT_EVENTS.terminalTransition, {
        reportRequestId: candidate.id,
        userId: candidate.userId,
        statusFrom: FROM_DB_STATUS[candidate.status],
        statusTo: "failed",
        stage,
        errorCode: input.failure.code,
      });
      const row = await tx.reportRequest.findUnique({
        where: { id: candidate.id },
        include: REQUEST_INCLUDE,
      });
      return row === null ? null : toDto(row);
    });
  }
  async markSent(input: MarkReportSentInput): Promise<ReportRequestDto | null> {
    const confirmedAt = input.confirmedAt ?? this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.reportRequest.findFirst({
        where: { id: input.reportRequestId, status: DbStatus.EMAIL_ACCEPTED },
        include: REQUEST_INCLUDE,
      });
      if (candidate === null || candidate.delivery?.acceptedAt === null) {
        return null;
      }

      const delivery = await tx.reportDelivery.updateMany({
        where: {
          reportRequestId: candidate.id,
          acceptedAt: { not: null },
          confirmedAt: null,
        },
        data: { confirmedAt },
      });
      if (delivery.count === 0) {
        return null;
      }
      const updated = await tx.reportRequest.updateMany({
        where: { id: candidate.id, status: DbStatus.EMAIL_ACCEPTED },
        data: {
          status: DbStatus.SENT,
          progressStage: "delivery_wait",
          sentAt: confirmedAt,
        },
      });
      if (updated.count === 0) {
        return null;
      }
      await completeJob(tx, candidate.id, confirmedAt, null);
      await writeTerminalAudit(tx, candidate, "sent");
      this.telemetry.emit(REPORT_EVENTS.terminalTransition, {
        reportRequestId: candidate.id,
        userId: candidate.userId,
        statusFrom: FROM_DB_STATUS[candidate.status],
        statusTo: "sent",
        stage: "delivery_wait",
      });
      const row = await tx.reportRequest.findUnique({
        where: { id: candidate.id },
        include: REQUEST_INCLUDE,
      });
      return row === null ? null : toDto(row);
    });
  }

  private emitAttemptBlocked(
    userId: string,
    operation: "create" | "retry",
    error: unknown,
    startedAt: number,
  ): void {
    if (
      !(error instanceof ReportDomainError) ||
      (error.code !== "report_in_progress" &&
        error.code !== "idempotency_conflict" &&
        error.code !== "retry_not_allowed")
    ) {
      return;
    }
    this.telemetry.emit(REPORT_EVENTS.requestBlocked, {
      reportRequestId: error instanceof ReportInProgressError
        ? error.activeRequest.id
        : undefined,
      userId,
      operation,
      disposition: "blocked",
      errorCode: error.code,
      durationMs: reportDurationMs(startedAt),
    });
  }
}

async function loadRetrySelection(
  tx: Transaction,
  userId: string,
  retryOfId: string,
): Promise<{ reportType: ReportType; referenceDate: ReportDateString }> {
  const original = await tx.reportRequest.findFirst({
    where: { id: retryOfId, userId },
    select: { status: true, reportType: true, referenceDate: true },
  });
  if (original === null) {
    throw new ReportDomainError("report_not_found");
  }
  if (original.status !== DbStatus.FAILED) {
    throw new ReportDomainError("retry_not_allowed");
  }
  return {
    reportType: FROM_DB_TYPE[original.reportType],
    referenceDate: fromDatabaseDate(original.referenceDate),
  };
}

function requireCreateSelection(input: AttemptInput): {
  reportType: ReportType;
  referenceDate: ReportDateString;
} {
  if (input.reportType === undefined || input.referenceDate === undefined) {
    throw new ReportDomainError("unexpected_report_error");
  }
  return { reportType: input.reportType, referenceDate: input.referenceDate };
}

function classifyExisting(
  existing: RequestRow,
  input: AttemptInput,
  selection: { reportType: ReportType; referenceDate: ReportDateString },
): ReportRequestMutationResult {
  const samePayload =
    existing.retryOfId === input.retryOfId &&
    FROM_DB_TYPE[existing.reportType] === selection.reportType &&
    fromDatabaseDate(existing.referenceDate) === selection.referenceDate;
  if (!samePayload) {
    throw new ReportDomainError("idempotency_conflict");
  }
  return { disposition: "replayed", request: toDto(existing) };
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
  candidate: RequestRow,
  statusTo: "sent" | "failed",
  extra: Record<string, string> = {},
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: candidate.userId,
      action: REPORT_AUDIT_ACTIONS.terminal,
      entityType: "ReportRequest",
      entityId: candidate.id,
      changes: auditChanges({
        statusFrom: FROM_DB_STATUS[candidate.status],
        statusTo,
        ...extra,
      }),
    },
  });
}

function auditChanges(
  value: Record<string, string | null>,
): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function failureProgressStage(
  stage: ReportFailureStage,
  current: string,
): ReportProgressStage {
  switch (stage) {
    case "data_retrieval":
    case "snapshot":
    case "csv_generation":
    case "email_submission":
      return stage;
    case "report_size":
      return "csv_generation";
    case "unexpected":
      return isProgressStage(current) ? current : "data_retrieval";
  }
}

function isProgressStage(value: string): value is ReportProgressStage {
  return [
    "data_retrieval",
    "snapshot",
    "csv_generation",
    "email_submission",
    "delivery_wait",
  ].includes(value);
}

function validateClientRequestId(value: string): void {
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidPattern.test(value)) {
    throw new ReportDomainError("invalid_client_request_id", {
      fieldErrors: { clientRequestId: "Use a valid UUID." },
    });
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002";
}

function toDatabaseDate(value: ReportDateString): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function fromDatabaseDate(value: Date): ReportDateString {
  const result = asReportDateString(value.toISOString().slice(0, 10));
  if (result === null) {
    throw new RangeError("Persisted report date is outside the supported range");
  }
  return result;
}
function toDto(row: RequestRow): ReportRequestDto {
  const status = FROM_DB_STATUS[row.status];
  const failure = persistedFailure(row.failureCode);
  return {
    id: row.id,
    reportType: FROM_DB_TYPE[row.reportType],
    referenceDate: fromDatabaseDate(row.referenceDate),
    period: {
      startDate: fromDatabaseDate(row.periodStart),
      endDate: fromDatabaseDate(row.periodEnd),
      inclusive: true,
    },
    accountEmail: row.accountEmail,
    status,
    progressStage: requireProgressStage(row.progressStage),
    createdAt: formatUtcTimestamp(row.createdAt),
    providerAcceptedAt: row.delivery?.acceptedAt
      ? formatUtcTimestamp(row.delivery.acceptedAt)
      : null,
    sentAt: row.sentAt ? formatUtcTimestamp(row.sentAt) : null,
    failure: status === "failed" ? failure : null,
    canRetry: status === "failed",
  };
}

function persistedFailure(code: string | null) {
  if (code !== null && REPORT_ERROR_CODES.includes(code as ReportErrorCode)) {
    return new ReportDomainError(code as ReportErrorCode).toPublicFailure();
  }
  return new ReportDomainError("unexpected_report_error").toPublicFailure();
}

function requireProgressStage(value: string): ReportProgressStage {
  if (!isProgressStage(value)) {
    throw new RangeError("Persisted report progress stage is invalid");
  }
  return value;
}

function toDbStatus(status: NonterminalStatus): DbStatus {
  return TO_DB_STATUS[status];
}

const TO_DB_TYPE: Record<ReportType, DbType> = {
  weekly: DbType.WEEKLY,
  monthly: DbType.MONTHLY,
};
const FROM_DB_TYPE: Record<DbType, ReportType> = {
  WEEKLY: "weekly",
  MONTHLY: "monthly",
};
const TO_DB_STATUS: Record<ReportStatus, DbStatus> = {
  pending: DbStatus.PENDING,
  processing: DbStatus.PROCESSING,
  email_submitted: DbStatus.EMAIL_SUBMITTED,
  email_accepted: DbStatus.EMAIL_ACCEPTED,
  sent: DbStatus.SENT,
  failed: DbStatus.FAILED,
};
const FROM_DB_STATUS: Record<DbStatus, ReportStatus> = {
  PENDING: "pending",
  PROCESSING: "processing",
  EMAIL_SUBMITTED: "email_submitted",
  EMAIL_ACCEPTED: "email_accepted",
  SENT: "sent",
  FAILED: "failed",
};
const DB_TERMINAL_STATUSES: DbStatus[] = [DbStatus.SENT, DbStatus.FAILED];
const TO_DB_FAILURE_STAGE: Record<ReportFailureStage, DbFailureStage> = {
  data_retrieval: DbFailureStage.DATA_RETRIEVAL,
  snapshot: DbFailureStage.SNAPSHOT,
  csv_generation: DbFailureStage.CSV_GENERATION,
  report_size: DbFailureStage.REPORT_SIZE,
  email_submission: DbFailureStage.EMAIL_SUBMISSION,
  unexpected: DbFailureStage.UNEXPECTED,
};
