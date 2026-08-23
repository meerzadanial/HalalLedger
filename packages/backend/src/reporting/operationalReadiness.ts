import { Prisma, PrismaClient } from "@prisma/client";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";
import type { ReportOperationalConfig } from "./operationalConfig";

export type ReadinessCheckState = "ok" | "failed";

export interface ReportReadinessResult {
  readonly status: "ready" | "not_ready";
  readonly checks: {
    readonly database: ReadinessCheckState;
    readonly migrations: ReadinessCheckState;
    readonly provider: ReadinessCheckState;
    readonly workerHeartbeat: ReadinessCheckState;
  };
  readonly checkedAt: string;
}

export class ReportWorkerHeartbeatRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async start(workerId: string): Promise<void> {
    const now = validDate(this.clock.now());
    await this.prisma.reportWorkerHeartbeat.upsert({
      where: { workerId },
      create: { workerId, startedAt: now, lastHeartbeatAt: now },
      update: { startedAt: now, lastHeartbeatAt: now, stoppedAt: null },
    });
  }

  async beat(workerId: string): Promise<void> {
    const now = validDate(this.clock.now());
    await this.prisma.reportWorkerHeartbeat.update({
      where: { workerId },
      data: { lastHeartbeatAt: now, stoppedAt: null },
    });
  }

  async stop(workerId: string): Promise<void> {
    const now = validDate(this.clock.now());
    await this.prisma.reportWorkerHeartbeat.updateMany({
      where: { workerId, stoppedAt: null },
      data: { lastHeartbeatAt: now, stoppedAt: now },
    });
  }
}

export class ReportReadinessService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: ReportOperationalConfig,
    private readonly clock: Clock = new SystemClock(),
  ) {}

  async check(): Promise<ReportReadinessResult> {
    const checkedAt = validDate(this.clock.now());
    const [database, migrations, workerHeartbeat] = await Promise.all([
      this.databaseReady(),
      this.migrationsReady(),
      this.workerReady(checkedAt),
    ]);
    const provider = this.config.provider.configured;
    const checks = {
      database: state(database),
      migrations: state(migrations),
      provider: state(provider),
      workerHeartbeat: state(workerHeartbeat),
    };
    return {
      status: Object.values(checks).every((value) => value === "ok")
        ? "ready"
        : "not_ready",
      checks,
      checkedAt: checkedAt.toISOString(),
    };
  }

  private async databaseReady(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
  private async migrationsReady(): Promise<boolean> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ compatible: boolean }>>(
        Prisma.sql`
          SELECT
            to_regclass('report_requests') IS NOT NULL
            AND to_regclass('report_jobs') IS NOT NULL
            AND to_regclass('report_worker_heartbeats') IS NOT NULL
            AND to_regclass('report_requests_one_active_per_user_idx') IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'report_deliveries'
                AND column_name = 'delivery_deadline_at'
            ) AS "compatible"
        `,
      );
      return rows[0]?.compatible === true;
    } catch {
      return false;
    }
  }

  private async workerReady(now: Date): Promise<boolean> {
    try {
      const cutoff = new Date(
        now.getTime() - this.config.workerHeartbeatMaxAgeMs,
      );
      const count = await this.prisma.reportWorkerHeartbeat.count({
        where: { stoppedAt: null, lastHeartbeatAt: { gte: cutoff } },
      });
      return count > 0;
    } catch {
      return false;
    }
  }
}

function state(value: boolean): ReadinessCheckState {
  return value ? "ok" : "failed";
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value);
}
