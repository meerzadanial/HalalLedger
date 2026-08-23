import { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import { InMemoryReportMetrics, silentReportTelemetry } from "./observability";
import {
  loadReportOperationalConfig,
  requireWorkerReportConfig,
} from "./operationalConfig";
import { ReportWorkerRuntime } from "./reportWorkerRuntime";

const NOW = new Date("2025-01-15T10:00:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };

function workerConfig() {
  const config = loadReportOperationalConfig({
    RESEND_API_KEY: "re_key",
    RESEND_WEBHOOK_SECRET: "whsec_dGVzdA==",
    REPORT_FROM_EMAIL: "reports@example.com",
    REPORT_PUBLIC_WEBHOOK_URL: "https://example.com/api/webhooks/resend",
    REPORT_WORKER_ID: "worker-a",
  });
  requireWorkerReportConfig(config);
  return config;
}

describe("ReportWorkerRuntime", () => {
  it("runs lease, claim, deadline, retention, metric, and heartbeat sweeps", async () => {
    const recordFailure = vi.fn().mockResolvedValue(null);
    const dependencies = {
      prisma: {
        reportDelivery: { count: vi.fn().mockResolvedValue(2) },
      } as unknown as PrismaClient,
      worker: { runOnce: vi.fn().mockResolvedValue({ disposition: "idle" }) },
      jobs: {
        reclaimExpiredLeases: vi.fn().mockResolvedValue({
          reclaimedCount: 1,
          exhaustedReportRequestIds: ["report-exhausted"],
        }),
      },
      requests: { recordFailure },
      deadlines: { sweep: vi.fn().mockResolvedValue({ timedOutCount: 0, reportRequestIds: [] }) },
      retention: { sweep: vi.fn().mockResolvedValue({ deletedAttachmentCount: 3, cutoff: NOW }) },
      heartbeat: {
        start: vi.fn().mockResolvedValue(undefined),
        beat: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      config: workerConfig(),
      clock,
      telemetry: silentReportTelemetry,
      metrics: new InMemoryReportMetrics(),
    };
    const runtime = new ReportWorkerRuntime(dependencies);

    await runtime.runCycle();

    expect(dependencies.worker.runOnce).toHaveBeenCalledOnce();
    expect(dependencies.deadlines.sweep).toHaveBeenCalledOnce();
    expect(dependencies.retention.sweep).toHaveBeenCalledOnce();
    expect(recordFailure).toHaveBeenCalledWith({
      reportRequestId: "report-exhausted",
      failure: expect.objectContaining({ code: "unexpected_report_error" }),
    });
    expect(dependencies.metrics.snapshot().gauges).toEqual(expect.arrayContaining([
      { name: "report_stale_leases", value: 2 },
      { name: "report_approaching_deadlines", value: 2 },
    ]));
    expect(dependencies.heartbeat.beat).toHaveBeenCalledWith("worker-a");
  });

  it("wakes an idle polling delay and records a stopped heartbeat", async () => {
    let markCycleCompleted!: () => void;
    const cycleCompleted = new Promise<void>((resolve) => {
      markCycleCompleted = resolve;
    });
    const heartbeat = {
      start: vi.fn().mockResolvedValue(undefined),
      beat: vi.fn().mockImplementation(async () => {
        markCycleCompleted();
      }),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const runtime = new ReportWorkerRuntime({
      prisma: {
        reportDelivery: { count: vi.fn().mockResolvedValue(0) },
      } as unknown as PrismaClient,
      worker: { runOnce: vi.fn().mockResolvedValue({ disposition: "idle" }) },
      jobs: {
        reclaimExpiredLeases: vi.fn().mockResolvedValue({
          reclaimedCount: 0,
          exhaustedReportRequestIds: [],
        }),
      },
      requests: { recordFailure: vi.fn().mockResolvedValue(null) },
      deadlines: { sweep: vi.fn().mockResolvedValue({ timedOutCount: 0, reportRequestIds: [] }) },
      retention: { sweep: vi.fn().mockResolvedValue({ deletedAttachmentCount: 0, cutoff: NOW }) },
      heartbeat,
      config: workerConfig(),
      clock,
      telemetry: silentReportTelemetry,
      metrics: new InMemoryReportMetrics(),
    });

    const run = runtime.run();
    await cycleCompleted;
    runtime.stop();
    await run;

    expect(heartbeat.start).toHaveBeenCalledWith("worker-a");
    expect(heartbeat.beat).toHaveBeenCalledOnce();
    expect(heartbeat.stop).toHaveBeenCalledWith("worker-a");
  });

  it("waits for an in-flight cycle before recording a stopped heartbeat", async () => {
    let markWorkerStarted!: () => void;
    let releaseWorker!: () => void;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const heartbeat = {
      start: vi.fn().mockResolvedValue(undefined),
      beat: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const worker = {
      runOnce: vi.fn(() => new Promise<{ disposition: "idle" }>((resolve) => {
        releaseWorker = () => resolve({ disposition: "idle" });
        markWorkerStarted();
      })),
    };
    const runtime = new ReportWorkerRuntime({
      prisma: {
        reportDelivery: { count: vi.fn().mockResolvedValue(0) },
      } as unknown as PrismaClient,
      worker,
      jobs: {
        reclaimExpiredLeases: vi.fn().mockResolvedValue({
          reclaimedCount: 0,
          exhaustedReportRequestIds: [],
        }),
      },
      requests: { recordFailure: vi.fn().mockResolvedValue(null) },
      deadlines: { sweep: vi.fn().mockResolvedValue({ timedOutCount: 0, reportRequestIds: [] }) },
      retention: { sweep: vi.fn().mockResolvedValue({ deletedAttachmentCount: 0, cutoff: NOW }) },
      heartbeat,
      config: workerConfig(),
      clock,
      telemetry: silentReportTelemetry,
      metrics: new InMemoryReportMetrics(),
    });

    const run = runtime.run();
    await workerStarted;
    runtime.stop();

    expect(heartbeat.stop).not.toHaveBeenCalled();
    releaseWorker();
    await run;

    expect(heartbeat.start).toHaveBeenCalledWith("worker-a");
    expect(worker.runOnce).toHaveBeenCalledOnce();
    expect(heartbeat.beat).toHaveBeenCalledOnce();
    expect(heartbeat.stop).toHaveBeenCalledWith("worker-a");
  });
});
