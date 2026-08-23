import { PrismaClient, ReportStatus } from "@prisma/client";
import { ReportDomainError } from "./errors";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";
import {
  REPORT_EVENTS,
  reportMetrics,
  reportTelemetry,
  type InMemoryReportMetrics,
  type ReportTelemetry,
} from "./observability";
import type { ReportOperationalConfig } from "./operationalConfig";
import type { ReportArtifactRetentionService } from "./artifactRetention";
import type { ReportDeliveryDeadlineReaper } from "./reportDeliveryDeadlineReaper";
import type { PostgresReportJobRepository } from "./reportJobRepository";
import type { ReportRequestService } from "./reportRequestService";
import type { ReportWorker } from "./reportWorker";
import type { ReportWorkerHeartbeatRepository } from "./operationalReadiness";

type Sleeper = (milliseconds: number) => Promise<void>;

export interface ReportWorkerRuntimeDependencies {
  readonly prisma: PrismaClient;
  readonly worker: Pick<ReportWorker, "runOnce">;
  readonly jobs: Pick<PostgresReportJobRepository, "reclaimExpiredLeases">;
  readonly requests: Pick<ReportRequestService, "recordFailure">;
  readonly deadlines: Pick<ReportDeliveryDeadlineReaper, "sweep">;
  readonly retention: Pick<ReportArtifactRetentionService, "sweep">;
  readonly heartbeat: Pick<ReportWorkerHeartbeatRepository, "start" | "beat" | "stop">;
  readonly config: ReportOperationalConfig & { readonly workerId: string };
  readonly clock?: Clock;
  readonly telemetry?: ReportTelemetry;
  readonly metrics?: InMemoryReportMetrics;
  readonly sleep?: Sleeper;
}

/** Owns the worker process loop; stop waits for the current durable cycle. */
export class ReportWorkerRuntime {
  private readonly clock: Clock;
  private readonly telemetry: ReportTelemetry;
  private readonly metrics: InMemoryReportMetrics;
  private readonly sleep: Sleeper;
  private stopping = false;
  private wake: (() => void) | null = null;
  private nextRetentionAt = 0;

  constructor(private readonly dependencies: ReportWorkerRuntimeDependencies) {
    this.clock = dependencies.clock ?? new SystemClock();
    this.telemetry = dependencies.telemetry ?? reportTelemetry;
    this.metrics = dependencies.metrics ?? reportMetrics;
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolve) => {
      const timeout = setTimeout(resolve, milliseconds);
      this.wake = () => {
        clearTimeout(timeout);
        resolve();
      };
    }));
  }

  async run(): Promise<void> {
    const { heartbeat, config } = this.dependencies;
    await heartbeat.start(config.workerId);
    try {
      while (!this.stopping) {
        try {
          await this.runCycle();
        } catch {
          this.telemetry.emit(REPORT_EVENTS.workerCycleFailed, {
            stage: "coordination",
            errorCode: "unexpected_report_error",
          });
        }
        if (!this.stopping) {
          await this.sleep(config.workerPollIntervalMs);
          this.wake = null;
        }
      }
    } finally {
      await heartbeat.stop(config.workerId);
    }
  }

  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  async runCycle(): Promise<void> {
    const { config, jobs, requests, worker, deadlines, heartbeat } = this.dependencies;
    const now = validDate(this.clock.now());
    const reclaimed = await jobs.reclaimExpiredLeases();
    const staleLeaseCount = reclaimed.reclaimedCount +
      reclaimed.exhaustedReportRequestIds.length;
    this.metrics.setGauge("report_stale_leases", staleLeaseCount);
    this.telemetry.emit(REPORT_EVENTS.leaseSweep, { staleLeaseCount });

    for (const reportRequestId of reclaimed.exhaustedReportRequestIds) {
      await requests.recordFailure({
        reportRequestId,
        failure: new ReportDomainError("unexpected_report_error"),
      });
    }

    await worker.runOnce();
    await deadlines.sweep();
    const approachingDeadlineCount = await this.countApproachingDeadlines(now);
    this.metrics.setGauge("report_approaching_deadlines", approachingDeadlineCount);

    if (now.getTime() >= this.nextRetentionAt) {
      const result = await this.dependencies.retention.sweep();
      this.nextRetentionAt = now.getTime() + config.retentionSweepIntervalMs;
      this.telemetry.emit(REPORT_EVENTS.retentionSweep, {
        deletedAttachmentCount: result.deletedAttachmentCount,
      });
    }
    await heartbeat.beat(config.workerId);
    this.telemetry.emit(REPORT_EVENTS.workerHeartbeat, {
      disposition: "healthy",
      approachingDeadlineCount,
    });
  }
  private countApproachingDeadlines(now: Date): Promise<number> {
    const deadline = new Date(
      now.getTime() +
      this.dependencies.config.alerts.approachingDeadlineSeconds * 1_000,
    );
    return this.dependencies.prisma.reportDelivery.count({
      where: {
        confirmedAt: null,
        deliveryDeadlineAt: { gt: now, lte: deadline },
        reportRequest: {
          is: {
            status: {
              in: [ReportStatus.EMAIL_SUBMITTED, ReportStatus.EMAIL_ACCEPTED],
            },
          },
        },
      },
    });
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value);
}
