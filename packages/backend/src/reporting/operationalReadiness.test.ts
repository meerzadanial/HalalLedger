import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import { InMemoryReportMetrics } from "./observability";
import { loadReportOperationalConfig } from "./operationalConfig";
import {
  ReportReadinessService,
  ReportWorkerHeartbeatRepository,
} from "./operationalReadiness";
import { deriveReportAlertStates } from "./reportAlerts";

const NOW = new Date("2025-01-15T10:00:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };
const config = loadReportOperationalConfig({
  RESEND_API_KEY: "re_key",
  RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
  REPORT_FROM_EMAIL: "reports@example.com",
  REPORT_PUBLIC_WEBHOOK_URL: "https://example.com/api/webhooks/resend",
  REPORT_WORKER_ID: "worker-a",
});

function readinessHarness(
  heartbeatCount: number,
  operationalConfig = config,
) {
  const queryRaw = vi.fn()
    .mockResolvedValueOnce([{ one: 1 }])
    .mockResolvedValueOnce([{ compatible: true }]);
  const heartbeat = { count: vi.fn().mockResolvedValue(heartbeatCount) };
  const prisma = {
    $queryRaw: queryRaw,
    reportWorkerHeartbeat: heartbeat,
  } as unknown as PrismaClient;
  return {
    queryRaw,
    heartbeat,
    service: new ReportReadinessService(prisma, operationalConfig, clock),
  };
}

describe("report operational readiness", () => {
  it("reports database, schema, provider, and fresh worker checks without values", async () => {
    const { service, heartbeat } = readinessHarness(1);

    const result = await service.check();

    expect(result).toEqual({
      status: "ready",
      checks: {
        database: "ok",
        migrations: "ok",
        provider: "ok",
        workerHeartbeat: "ok",
      },
      checkedAt: NOW.toISOString(),
    });
    expect(heartbeat.count).toHaveBeenCalledWith({
      where: {
        stoppedAt: null,
        lastHeartbeatAt: { gte: new Date("2025-01-15T09:58:00.000Z") },
      },
    });
    expect(JSON.stringify(result)).not.toContain("re_key");
    expect(JSON.stringify(result)).not.toContain("whsec_");
  });

  it("accepts a heartbeat at the exact freshness cutoff and rejects one millisecond older", async () => {
    const checkAt = async (lastHeartbeatAt: Date) => {
      const queryRaw = vi.fn()
        .mockResolvedValueOnce([{ one: 1 }])
        .mockResolvedValueOnce([{ compatible: true }]);
      const reportWorkerHeartbeat = {
        count: vi.fn().mockImplementation((query: {
          where: { lastHeartbeatAt: { gte: Date } };
        }) => Promise.resolve(
          lastHeartbeatAt >= query.where.lastHeartbeatAt.gte ? 1 : 0,
        )),
      };
      const service = new ReportReadinessService(
        { $queryRaw: queryRaw, reportWorkerHeartbeat } as unknown as PrismaClient,
        config,
        clock,
      );
      return service.check();
    };

    await expect(checkAt(new Date("2025-01-15T09:58:00.000Z"))).resolves
      .toMatchObject({ status: "ready", checks: { workerHeartbeat: "ok" } });
    await expect(checkAt(new Date("2025-01-15T09:57:59.999Z"))).resolves
      .toMatchObject({ status: "not_ready", checks: { workerHeartbeat: "failed" } });
  });

  it("lets the API probe run without worker-only config and reports unavailable dependencies", async () => {
    const apiConfig = loadReportOperationalConfig({});
    const { service } = readinessHarness(0, apiConfig);

    await expect(service.check()).resolves.toMatchObject({
      status: "not_ready",
      checks: {
        database: "ok",
        migrations: "ok",
        provider: "failed",
        workerHeartbeat: "failed",
      },
    });
  });

  it("reports provider configuration presence without exposing configured values", async () => {
    const partialProviderConfig = loadReportOperationalConfig({
      RESEND_API_KEY: "re_sentinel_api_key",
      RESEND_WEBHOOK_SECRET: "whsec_c2VudGluZWw=",
      REPORT_FROM_EMAIL: "sentinel@example.com",
      REPORT_WORKER_ID: "worker-sentinel",
    });
    const { service } = readinessHarness(1, partialProviderConfig);

    const result = await service.check();
    const serialized = JSON.stringify(result);

    expect(result).toMatchObject({
      status: "not_ready",
      checks: {
        database: "ok",
        migrations: "ok",
        provider: "failed",
        workerHeartbeat: "ok",
      },
    });
    expect(serialized).not.toContain("re_sentinel_api_key");
    expect(serialized).not.toContain("whsec_c2VudGluZWw=");
    expect(serialized).not.toContain("sentinel@example.com");
    expect(serialized).not.toContain("worker-sentinel");
  });

  it("persists worker start, heartbeat, and graceful stop timestamps", async () => {
    const reportWorkerHeartbeat = {
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    };
    const repository = new ReportWorkerHeartbeatRepository(
      { reportWorkerHeartbeat } as unknown as PrismaClient,
      clock,
    );

    await repository.start("worker-a");
    await repository.beat("worker-a");
    await repository.stop("worker-a");

    expect(reportWorkerHeartbeat.upsert).toHaveBeenCalledWith({
      where: { workerId: "worker-a" },
      create: { workerId: "worker-a", startedAt: NOW, lastHeartbeatAt: NOW },
      update: { startedAt: NOW, lastHeartbeatAt: NOW, stoppedAt: null },
    });
    expect(reportWorkerHeartbeat.update).toHaveBeenCalledWith({
      where: { workerId: "worker-a" },
      data: { lastHeartbeatAt: NOW, stoppedAt: null },
    });
    expect(reportWorkerHeartbeat.updateMany).toHaveBeenCalledWith({
      where: { workerId: "worker-a", stoppedAt: null },
      data: { lastHeartbeatAt: NOW, stoppedAt: NOW },
    });
  });
});

describe("metric-derived report alerts", () => {
  it("stays inactive below configured thresholds and activates exactly at them", () => {
    const metrics = new InMemoryReportMetrics();
    metrics.setGauge("report_stale_leases", config.alerts.staleLeaseCount - 1);
    metrics.setGauge(
      "report_approaching_deadlines",
      config.alerts.approachingDeadlineCount - 1,
    );
    for (let index = 1; index < config.alerts.failureSpikeCount; index += 1) {
      metrics.increment("report_terminal_total", { statusTo: "failed" });
    }
    for (
      let index = 1;
      index < config.alerts.invalidSignatureSpikeCount;
      index += 1
    ) {
      metrics.increment("report_webhooks_total", {
        errorCode: "invalid_provider_signature",
      });
    }

    expect(deriveReportAlertStates(metrics.snapshot(), config.alerts)).toEqual({
      staleLeases: false,
      failureSpike: false,
      invalidSignatureSpike: false,
      approachingDeadlines: false,
    });

    metrics.setGauge("report_stale_leases", config.alerts.staleLeaseCount);
    metrics.setGauge(
      "report_approaching_deadlines",
      config.alerts.approachingDeadlineCount,
    );
    metrics.increment("report_terminal_total", { statusTo: "failed" });
    metrics.increment("report_webhooks_total", {
      errorCode: "invalid_provider_signature",
    });

    expect(deriveReportAlertStates(metrics.snapshot(), config.alerts)).toEqual({
      staleLeases: true,
      failureSpike: true,
      invalidSignatureSpike: true,
      approachingDeadlines: true,
    });
  });
});
