import dotenv from "dotenv";
import { closeDatabase, initializeDatabase } from "./database";
import {
  CsvReportGenerator,
  PostgresReportJobRepository,
  ReportArtifactRetentionService,
  ReportDataService,
  ReportDeliveryDeadlineReaper,
  ReportEmailService,
  ReportPeriodResolver,
  ReportRequestService,
  ReportWorker,
  ReportWorkerHeartbeatRepository,
  ReportWorkerRuntime,
  ResendEmailProvider,
  SystemClock,
  loadReportOperationalConfig,
  requireWorkerReportConfig,
} from "./reporting";

dotenv.config();

export async function runReportWorkerProcess(): Promise<void> {
  const config = loadReportOperationalConfig();
  requireWorkerReportConfig(config);

  const database = await initializeDatabase();
  const prisma = database.getClient();
  const clock = new SystemClock();
  const jobs = new PostgresReportJobRepository(prisma, clock, undefined, {
    defaultMaxAttempts: config.maxAttempts,
    initialBackoffMs: config.initialBackoffMs,
    maxBackoffMs: config.maxBackoffMs,
  });
  const requests = new ReportRequestService(
    prisma,
    new ReportPeriodResolver(clock),
    clock,
    undefined,
    jobs,
  );
  const data = new ReportDataService(prisma, requests);
  const provider = new ResendEmailProvider({
    apiKey: config.provider.apiKey,
    webhookSecret: config.provider.webhookSecret,
    fromEmail: config.provider.fromEmail,
  });
  const email = new ReportEmailService(prisma, provider, clock, requests);
  const worker = new ReportWorker(
    prisma,
    jobs,
    requests,
    data,
    new CsvReportGenerator(clock),
    email,
    {
      workerId: config.workerId,
      leaseDurationMs: config.leaseDurationMs,
      attachmentLimitBytes: config.attachmentLimitBytes,
      clock,
    },
  );
  const runtime = new ReportWorkerRuntime({
    prisma,
    worker,
    jobs,
    requests,
    deadlines: new ReportDeliveryDeadlineReaper(prisma, clock),
    retention: new ReportArtifactRetentionService(
      prisma,
      { retentionDays: config.retentionDays },
      clock,
    ),
    heartbeat: new ReportWorkerHeartbeatRepository(prisma, clock),
    config,
    clock,
  });

  const stop = (): void => runtime.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    await runtime.run();
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
    await closeDatabase();
  }
}

if (require.main === module) {
  void runReportWorkerProcess().catch(() => {
    console.error("Report worker failed to start or stopped unexpectedly.");
    process.exitCode = 1;
  });
}
