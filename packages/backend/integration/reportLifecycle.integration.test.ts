import { createHash, createHmac, randomUUID } from "node:crypto";
import { PrismaClient, ReportStatus } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CsvReportGenerator,
  DefaultReportTelemetry,
  EmailProviderSubmissionError,
  InMemoryReportMetrics,
  JsonReportLogger,
  PostgresReportJobRepository,
  ProviderEventProcessor,
  ReportDataService,
  ReportDeliveryDeadlineReaper,
  ReportEmailService,
  ReportPeriodResolver,
  ReportRequestService,
  ReportWorker,
  ResendEmailProvider,
  type Clock,
  type EmailProvider,
  type EmailProviderAcceptance,
  type EmailProviderCommand,
  type ProviderWebhookHeaders,
  type ReportTelemetry,
} from "../src/reporting";
import { createReportRouter } from "../src/routes/reports";
import { createResendWebhookRouter } from "../src/routes/resendWebhook";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.includes("bulk_report_integration_")) {
  throw new Error("Lifecycle integration tests require the generated disposable database.");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const START = new Date("2025-01-15T10:00:00.000Z");
const SIGNING_KEY = Buffer.from("lifecycle-signing-key-32-bytes!!", "utf8");
const WEBHOOK_SECRET = `whsec_${SIGNING_KEY.toString("base64")}`;

class MutableClock implements Clock {
  constructor(private instant = new Date(START)) {}
  now(): Date { return new Date(this.instant); }
  advance(milliseconds: number): void { this.instant = new Date(this.instant.getTime() + milliseconds); }
}

class SignedFakeProvider implements EmailProvider {
  readonly calls: EmailProviderCommand[] = [];
  readonly logicalMessages = new Map<string, EmailProviderAcceptance>();
  mode: "accept" | "ambiguous_once" | "reject" = "accept";
  private readonly ambiguous = new Set<string>();
  private readonly verifier: ResendEmailProvider;

  constructor(private readonly clock: Clock) {
    this.verifier = new ResendEmailProvider({
      apiKey: "re_lifecycle_fake",
      webhookSecret: WEBHOOK_SECRET,
      fromEmail: "Reports <reports@example.test>",
    }, {
      clock,
      client: { emails: { send: async () => ({ data: { id: "unused" }, error: null }) } },
    });
  }

  async submit(command: EmailProviderCommand): Promise<EmailProviderAcceptance> {
    this.calls.push(command);
    if (this.mode === "reject") throw new EmailProviderSubmissionError("rejected");
    let acceptance = this.logicalMessages.get(command.idempotencyKey);
    if (acceptance === undefined) {
      acceptance = {
        providerMessageId: `provider-${this.logicalMessages.size + 1}`,
        acceptedAt: this.clock.now(),
      };
      this.logicalMessages.set(command.idempotencyKey, acceptance);
    }
    if (this.mode === "ambiguous_once" && !this.ambiguous.has(command.idempotencyKey)) {
      this.ambiguous.add(command.idempotencyKey);
      throw new EmailProviderSubmissionError("unavailable");
    }
    return acceptance;
  }

  verifyWebhook(rawBody: Buffer, headers: ProviderWebhookHeaders) {
    return this.verifier.verifyWebhook(rawBody, headers);
  }
}

function telemetryHarness() {
  const lines: string[] = [];
  const metrics = new InMemoryReportMetrics();
  const telemetry = new DefaultReportTelemetry(new JsonReportLogger((line) => lines.push(line)), metrics);
  return { telemetry, metrics, lines };
}

type ServiceOptions = {
  provider?: SignedFakeProvider;
  dataClient?: PrismaClient;
  attachmentLimitBytes?: number;
  maxAttempts?: number;
  telemetry?: ReportTelemetry;
};

function makeServices(clock: MutableClock, options: ServiceOptions = {}) {
  const telemetry = options.telemetry ?? telemetryHarness().telemetry;
  const provider = options.provider ?? new SignedFakeProvider(clock);
  const jobs = new PostgresReportJobRepository(prisma, clock, undefined, {
    defaultMaxAttempts: options.maxAttempts ?? 3,
    initialBackoffMs: 10,
    maxBackoffMs: 20,
  });
  const resolver = new ReportPeriodResolver(clock);
  const requests = new ReportRequestService(prisma, resolver, clock, undefined, jobs, telemetry);
  const data = new ReportDataService(options.dataClient ?? prisma, requests, telemetry);
  const csv = new CsvReportGenerator(clock, telemetry);
  const email = new ReportEmailService(prisma, provider, clock, requests, undefined, telemetry);
  const worker = (workerId: string) => new ReportWorker(
    prisma, jobs, requests, data, csv, email,
    { workerId, leaseDurationMs: 1_000, attachmentLimitBytes: options.attachmentLimitBytes, clock },
    undefined,
    telemetry,
  );
  const processor = new ProviderEventProcessor(prisma, clock, telemetry);
  const reaper = new ReportDeliveryDeadlineReaper(prisma, clock, {}, telemetry);
  return { telemetry, provider, jobs, resolver, requests, data, csv, email, worker, processor, reaper };
}

const sessions = new Map<string, { userId: string; email: string }>();
type TestUser = { id: string; email: string; token: string };

async function createUser(): Promise<TestUser> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const token = `token-${id}`;
  await prisma.user.create({ data: { id, email, passwordHash: "integration-only" } });
  sessions.set(token, { userId: id, email });
  return { id, email, token };
}

async function addEntry(userId: string, values: Record<string, unknown> = {}) {
  return prisma.deliveryEntry.create({ data: {
    id: randomUUID(), userId, restaurantName: "Lifecycle Cafe", restaurantStatus: "halal",
    fareAmount: "10.00", hasCashOrder: false, cashAmount: null,
    entryDate: new Date("2025-01-08T00:00:00.000Z"),
    timestamp: new Date("2025-01-08T08:00:00.000Z"),
    ...values,
  } as never });
}

function buildApp(services: ReturnType<typeof makeServices>) {
  const app = express();
  app.use("/api/webhooks/resend", createResendWebhookRouter({
    getServices: () => ({ provider: services.provider, processor: services.processor }),
    telemetry: services.telemetry,
  }));
  app.use(express.json());
  app.use("/api", createReportRouter({
    authenticate: async (token) => {
      const session = sessions.get(token);
      if (session === undefined) throw new Error("invalid session");
      return session;
    },
    getServices: () => ({
      periodResolver: services.resolver,
      requestService: services.requests,
      findAccount: (userId) => prisma.user.findUnique({
        where: { id: userId }, select: { email: true, timeZone: true },
      }),
    }),
    telemetry: services.telemetry,
  }));
  return app;
}

function auth(user: TestUser, call: request.Test): request.Test {
  return call.set("Authorization", `Bearer ${user.token}`);
}

async function createRequest(app: express.Express, user: TestUser) {
  return auth(user, request(app).post("/api/report-requests")).send({
    reportType: "weekly", referenceDate: "2025-01-08", clientRequestId: randomUUID(),
  });
}

function signedEvent(clock: Clock, eventId: string, messageId: string, type: string) {
  const timestamp = String(Math.floor(clock.now().getTime() / 1_000));
  const rawBody = JSON.stringify({
    type,
    created_at: clock.now().toISOString(),
    data: { email_id: messageId },
  });
  const signature = createHmac("sha256", SIGNING_KEY)
    .update(Buffer.concat([
      Buffer.from(`${eventId}.${timestamp}.`, "utf8"),
      Buffer.from(rawBody, "utf8"),
    ]))
    .digest("base64");
  return { rawBody, headers: {
    "content-type": "application/json",
    "svix-id": eventId,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  } };
}

async function postEvent(app: express.Express, fixture: ReturnType<typeof signedEvent>) {
  return request(app).post("/api/webhooks/resend").set(fixture.headers).send(fixture.rawBody);
}

beforeAll(async () => prisma.$connect(), 30_000);
beforeEach(async () => {
  sessions.clear();
  await prisma.providerEvent.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.user.deleteMany();
});
afterAll(async () => prisma.$disconnect(), 30_000);

describe("full authenticated report lifecycle", () => {
  it("creates, snapshots, renders, accepts, and confirms one immutable owned report", async () => {
    const clock = new MutableClock();
    const observed = telemetryHarness();
    const provider = new SignedFakeProvider(clock);
    const services = makeServices(clock, { provider, telemetry: observed.telemetry });
    const app = buildApp(services);
    const owner = await createUser();
    const other = await createUser();
    const start = await addEntry(owner.id, {
      restaurantName: "=Boundary, Café", fareAmount: "10.00", hasCashOrder: true,
      cashAmount: "2.00", entryDate: new Date("2025-01-06T00:00:00.000Z"),
    });
    const end = await addEntry(owner.id, {
      restaurantName: "End Shop", restaurantStatus: "non-halal", fareAmount: "20.00",
      hasCashOrder: false, cashAmount: "99.99", entryDate: new Date("2025-01-12T00:00:00.000Z"),
    });
    await addEntry(owner.id, { restaurantName: "Outside", entryDate: new Date("2025-01-13T00:00:00.000Z") });
    await addEntry(other.id, { restaurantName: "Private", entryDate: new Date("2025-01-08T00:00:00.000Z") });

    const created = await createRequest(app, owner);
    expect(created.status).toBe(202);
    const requestId = created.body.id as string;
    expect(await auth(other, request(app).get(`/api/report-requests/${requestId}`))).toMatchObject({ status: 404 });
    const blocked = await createRequest(app, owner);
    expect(blocked).toMatchObject({ status: 409, body: expect.objectContaining({ code: "report_in_progress" }) });

    const early = signedEvent(clock, "event-early", "provider-1", "email.delivered");
    expect(await postEvent(app, early)).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(await services.worker("lifecycle-worker").runOnce()).toEqual({
      disposition: "acknowledged", reportRequestId: requestId,
    });

    const persisted = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: requestId }, include: { snapshot: { include: { entries: true } }, attachment: true, delivery: true },
    });
    expect(persisted.status).toBe(ReportStatus.EMAIL_ACCEPTED);
    expect(persisted.snapshot).toMatchObject({
      recordCount: 2,
      digitalIncomeTotal: expect.objectContaining({}),
      cashIncomeTotal: expect.objectContaining({}),
    });
    expect(persisted.snapshot?.digitalIncomeTotal.toFixed(2)).toBe("30.00");
    expect(persisted.snapshot?.cashIncomeTotal.toFixed(2)).toBe("2.00");
    expect(persisted.snapshot?.halalIncomeTotal.toFixed(2)).toBe("12.00");
    expect(persisted.snapshot?.nonHalalIncomeTotal.toFixed(2)).toBe("20.00");
    expect(new Set(persisted.snapshot?.entries.map((row) => row.sourceEntryId))).toEqual(new Set([start.id, end.id]));
    expect(persisted.delivery).toMatchObject({
      idempotencyKey: `report:${requestId}`,
      providerMessageId: "provider-1",
      submittedAt: START,
      acceptedAt: START,
      deliveryDeadlineAt: new Date(START.getTime() + 300_000),
      confirmedAt: null,
    });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toMatchObject({
      idempotencyKey: `report:${requestId}`, to: [owner.email],
      attachment: { filename: "weekly_2025-01-06_2025-01-12.csv", mediaType: "text/csv; charset=UTF-8" },
    });
    expect(provider.calls[0].textBody).toContain("Digital Income Total: 30.00");
    const originalBytes = Buffer.from(persisted.attachment!.content);
    expect(persisted.attachment!.byteSize).toBe(originalBytes.byteLength);
    expect(persisted.attachment!.sha256).toBe(
      createHash("sha256").update(originalBytes).digest("hex"),
    );
    const csv = originalBytes.toString("utf8");
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv).toContain("'=Boundary, Café");
    expect(csv).toContain("Digital Income Total,30.00\r\n");
    expect(csv).not.toContain("Outside");
    expect(csv).not.toContain("Private");

    await prisma.deliveryEntry.update({ where: { id: start.id }, data: { restaurantName: "Mutated", fareAmount: "999.00" } });
    await prisma.deliveryEntry.delete({ where: { id: end.id } });
    await prisma.reportJob.update({ where: { reportRequestId: requestId }, data: { completedAt: null, availableAt: clock.now() } });
    expect(await services.worker("restart-after-acceptance").runOnce()).toMatchObject({ disposition: "acknowledged" });
    expect(Buffer.from((await prisma.reportAttachment.findUniqueOrThrow({ where: { reportRequestId: requestId } })).content)).toEqual(originalBytes);
    expect(provider.calls).toHaveLength(1);

    clock.advance(2_000);
    const delivered = signedEvent(clock, "event-delivered", "provider-1", "email.delivered");
    const deliveredResponse = await postEvent(app, delivered);
    expect(deliveredResponse).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(await postEvent(app, delivered)).toMatchObject({ status: 200, body: { received: true, duplicate: true } });
    const lateFailure = signedEvent(clock, "event-late-failed", "provider-1", "email.failed");
    expect(await postEvent(app, lateFailure)).toMatchObject({ status: 200 });

    const status = await auth(owner, request(app).get(`/api/report-requests/${requestId}`));
    expect(status.body).toMatchObject({ status: "sent", sentAt: clock.now().toISOString(), failure: null, canRetry: false });
    expect(Object.keys(status.body).sort()).toEqual([
      "accountEmail", "canRetry", "createdAt", "failure", "id", "period", "progressStage",
      "providerAcceptedAt", "referenceDate", "reportType", "sentAt", "status",
    ]);
    expect(JSON.stringify(status.body)).not.toMatch(/content|providerMessage|password|signature|token/iu);
    expect(await prisma.auditLog.count({ where: { entityId: requestId } })).toBe(2);
    expect(await prisma.providerEvent.count()).toBe(3);
    const counters = observed.metrics.snapshot().counters;
    expect(counters.some((metric) => metric.name === "report_snapshots_total")).toBe(true);
    expect(counters.some((metric) => metric.name === "report_csv_generated_total")).toBe(true);
    expect(counters.some((metric) => metric.name === "report_terminal_total")).toBe(true);
    expect(observed.lines.join("\n")).not.toContain(owner.email);
  });

  it.each([
    ["data retrieval", "data_retrieval_failed", "data_retrieval"],
    ["snapshot", "snapshot_failed", "snapshot"],
    ["CSV", "missing_required_cash_amount", "csv_generation"],
    ["report size", "report_too_large", "report_size"],
    ["provider rejection", "provider_rejected", "email_submission"],
    ["unexpected infrastructure", "unexpected_report_error", "unexpected"],
  ] as const)("persists a safe %s failure and creates one immutable retry", async (kind, code, stage) => {
    const clock = new MutableClock();
    const observed = telemetryHarness();
    const provider = new SignedFakeProvider(clock);
    let dataClient: PrismaClient | undefined;
    let trigger: { name: string; fn: string } | undefined;

    if (kind === "data retrieval" || kind === "unexpected infrastructure") {
      dataClient = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
      dataClient.$use(async (params, next) => {
        if (kind === "data retrieval" && params.model === "DeliveryEntry" && params.action === "findMany") {
          throw new Error("database-password=SENTINEL_DATA_SECRET");
        }
        if (kind === "unexpected infrastructure" && params.model === "ReportSnapshot" && params.action === "findFirst") {
          throw new Error("session-token=SENTINEL_UNEXPECTED_SECRET");
        }
        return next(params);
      });
      await dataClient.$connect();
    }
    if (kind === "provider rejection") provider.mode = "reject";

    const services = makeServices(clock, {
      provider, dataClient, telemetry: observed.telemetry, maxAttempts: 1,
      attachmentLimitBytes: kind === "report size" ? 1 : undefined,
    });
    const app = buildApp(services);
    const user = await createUser();
    const sourceEntry = await addEntry(user.id, kind === "CSV"
      ? { hasCashOrder: true, cashAmount: null }
      : { restaurantName: "Failure Café", hasCashOrder: true, cashAmount: "1.00" });
    const created = await createRequest(app, user);
    expect(created.status).toBe(202);
    const requestId = created.body.id as string;

    if (kind === "snapshot") {
      const suffix = randomUUID().replaceAll("-", "");
      trigger = { name: `lifecycle_snapshot_${suffix}`, fn: `lifecycle_snapshot_fn_${suffix}` };
      await prisma.$executeRawUnsafe(`
        CREATE FUNCTION "${trigger.fn}"() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'snapshot credential SENTINEL_SNAPSHOT_SECRET'; END;
        $$ LANGUAGE plpgsql
      `);
      await prisma.$executeRawUnsafe(`
        CREATE TRIGGER "${trigger.name}" BEFORE INSERT ON report_snapshot_entries
        FOR EACH ROW EXECUTE FUNCTION "${trigger.fn}"()
      `);
    }

    try {
      const result = await services.worker(`failure-${kind}`).runOnce();
      expect(result).toMatchObject({ disposition: "failed", reportRequestId: requestId, errorCode: code });
      const failedRow = await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } });
      expect(failedRow).toMatchObject({ status: ReportStatus.FAILED, failureCode: code });
      const [snapshotCount, attachmentCount, deliveryCount, sourceAfterFailure] = await Promise.all([
        prisma.reportSnapshot.count({ where: { reportRequestId: requestId } }),
        prisma.reportAttachment.count({ where: { reportRequestId: requestId } }),
        prisma.reportDelivery.count({ where: { reportRequestId: requestId } }),
        prisma.deliveryEntry.findUniqueOrThrow({ where: { id: sourceEntry.id } }),
      ]);
      const expectedArtifacts = {
        "data retrieval": [0, 0, 0],
        snapshot: [0, 0, 0],
        CSV: [1, 0, 0],
        "report size": [1, 0, 0],
        "provider rejection": [1, 1, 1],
        "unexpected infrastructure": [0, 0, 0],
      } as const;
      expect([snapshotCount, attachmentCount, deliveryCount]).toEqual(expectedArtifacts[kind]);
      expect(sourceAfterFailure).toEqual(sourceEntry);
      if (kind === "report size") expect(provider.calls).toHaveLength(0);
      if (kind === "provider rejection") expect(provider.calls).toHaveLength(1);

      const dto = await auth(user, request(app).get(`/api/report-requests/${requestId}`));
      expect(dto.body).toMatchObject({ status: "failed", canRetry: true, failure: { code, stage } });
      expect(JSON.stringify(dto.body)).not.toMatch(/SENTINEL|stack|credential|password|session-token/iu);
      const originalAfterFailure = await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } });
      const retry = await auth(user, request(app).post(`/api/report-requests/${requestId}/retries`)).send({
        clientRequestId: randomUUID(),
      });
      expect(retry).toMatchObject({ status: 202, body: expect.objectContaining({ status: "pending", failure: null }) });
      const retryRow = await prisma.reportRequest.findUniqueOrThrow({ where: { id: retry.body.id } });
      expect(retryRow.retryOfId).toBe(requestId);
      expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).toEqual(originalAfterFailure);
      expect(await prisma.auditLog.count({ where: { entityId: requestId } })).toBe(2);
      expect(observed.metrics.snapshot().counters.some((metric) =>
        metric.name === "report_terminal_total" && metric.labels.errorCode === code
      )).toBe(true);

      // Remove the injected fault, then execute the retry through a fresh set of
      // services to prove recovery does not depend on the failed worker process.
      if (trigger !== undefined) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger.name}" ON report_snapshot_entries`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trigger.fn}"()`);
        trigger = undefined;
      }
      if (kind === "CSV") {
        await prisma.deliveryEntry.updateMany({
          where: { userId: user.id, hasCashOrder: true },
          data: { cashAmount: "1.00" },
        });
      }

      const recoveryProvider = new SignedFakeProvider(clock);
      const recovery = makeServices(clock, {
        provider: recoveryProvider,
        telemetry: observed.telemetry,
      });
      const recoveryApp = buildApp(recovery);
      await expect(recovery.worker(`retry-${kind}`).runOnce()).resolves.toEqual({
        disposition: "acknowledged",
        reportRequestId: retryRow.id,
      });
      expect(recoveryProvider.calls).toHaveLength(1);
      expect(recoveryProvider.calls[0].idempotencyKey).toBe(`report:${retryRow.id}`);
      expect(await prisma.reportDelivery.count({ where: { reportRequestId: retryRow.id } })).toBe(1);

      const retryMessage = recoveryProvider.logicalMessages.get(`report:${retryRow.id}`);
      expect(retryMessage).toBeDefined();
      const deliveredRetry = signedEvent(
        clock,
        `retry-delivered-${randomUUID()}`,
        retryMessage!.providerMessageId,
        "email.delivered",
      );
      expect(await postEvent(recoveryApp, deliveredRetry)).toMatchObject({
        status: 200,
        body: { received: true, duplicate: false },
      });
      const recoveredDto = await auth(user, request(recoveryApp).get(`/api/report-requests/${retryRow.id}`));
      expect(recoveredDto.body).toMatchObject({
        status: "sent",
        failure: null,
        canRetry: false,
      });
      expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).toEqual(originalAfterFailure);
      expect(await prisma.auditLog.findMany({
        where: { entityId: retryRow.id },
        select: { action: true },
      })).toEqual(expect.arrayContaining([
        { action: "report_request.retried" },
        { action: "report_request.terminal" },
      ]));
      expect(observed.metrics.snapshot().counters.some((metric) =>
        metric.name === "report_retries_total" && metric.labels.reportRequestId === retryRow.id
      )).toBe(true);
    } finally {
      if (trigger !== undefined) {
        await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${trigger.name}" ON report_snapshot_entries`);
        await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${trigger.fn}"()`);
      }
      await dataClient?.$disconnect();
    }
  });

  it("fails an accepted email on a signed rejection, retains a late delivery, and retries safely", async () => {
    const clock = new MutableClock();
    const observed = telemetryHarness();
    const services = makeServices(clock, { telemetry: observed.telemetry });
    const app = buildApp(services);
    const user = await createUser();
    await addEntry(user.id, { restaurantName: "Rejected After Acceptance" });
    const created = await createRequest(app, user);
    const requestId = created.body.id as string;

    await expect(services.worker("accepted-before-rejection").runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: requestId,
    });
    const messageId = services.provider.logicalMessages.get(`report:${requestId}`)!.providerMessageId;
    const rejection = signedEvent(clock, "event-provider-rejected", messageId, "email.failed");
    expect(await postEvent(app, rejection)).toMatchObject({
      status: 200,
      body: { received: true, duplicate: false },
    });

    const originalFailure = await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } });
    expect(originalFailure).toMatchObject({
      status: ReportStatus.FAILED,
      failureCode: "provider_rejected",
    });
    expect(await prisma.reportDelivery.count({ where: { reportRequestId: requestId } })).toBe(1);
    expect(services.provider.calls).toHaveLength(1);

    clock.advance(1_000);
    const lateDelivery = signedEvent(clock, "event-delivered-after-rejection", messageId, "email.delivered");
    expect(await postEvent(app, lateDelivery)).toMatchObject({
      status: 200,
      body: { received: true, duplicate: false },
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).toEqual(originalFailure);
    expect((await prisma.reportDelivery.findUniqueOrThrow({ where: { reportRequestId: requestId } })).confirmedAt).toBeNull();

    const retry = await auth(user, request(app).post(`/api/report-requests/${requestId}/retries`)).send({
      clientRequestId: randomUUID(),
    });
    expect(retry.status).toBe(202);
    const retryId = retry.body.id as string;
    const recoveryProvider = new SignedFakeProvider(clock);
    const recovery = makeServices(clock, { provider: recoveryProvider, telemetry: observed.telemetry });
    const recoveryApp = buildApp(recovery);
    await expect(recovery.worker("provider-rejection-retry").runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: retryId,
    });
    const retryMessageId = recoveryProvider.logicalMessages.get(`report:${retryId}`)!.providerMessageId;
    expect(await postEvent(
      recoveryApp,
      signedEvent(clock, "event-retry-delivered", retryMessageId, "email.delivered"),
    )).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(await auth(user, request(recoveryApp).get(`/api/report-requests/${retryId}`))).toMatchObject({
      status: 200,
      body: expect.objectContaining({ status: "sent", failure: null, canRetry: false }),
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).toEqual(originalFailure);
    expect(observed.metrics.snapshot().counters.some((metric) =>
      metric.name === "report_terminal_total" && metric.labels.errorCode === "provider_rejected"
    )).toBe(true);
    expect(observed.metrics.snapshot().counters.some((metric) =>
      metric.name === "report_retries_total" && metric.labels.reportRequestId === retryId
    )).toBe(true);
  });

  it("fails exactly at the delivery deadline and retains a late signed confirmation diagnostically", async () => {
    const clock = new MutableClock();
    const observed = telemetryHarness();
    const services = makeServices(clock, { telemetry: observed.telemetry });
    const app = buildApp(services);
    const user = await createUser();
    await addEntry(user.id);
    const created = await createRequest(app, user);
    const requestId = created.body.id as string;
    await services.worker("deadline-worker").runOnce();
    const messageId = services.provider.logicalMessages.get(`report:${requestId}`)!.providerMessageId;

    clock.advance(299_999);
    await expect(services.reaper.sweep()).resolves.toEqual({ timedOutCount: 0, reportRequestIds: [] });
    expect((await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).status)
      .toBe(ReportStatus.EMAIL_ACCEPTED);
    clock.advance(1);
    await expect(services.reaper.sweep()).resolves.toEqual({ timedOutCount: 1, reportRequestIds: [requestId] });

    const late = signedEvent(clock, "event-after-timeout", messageId, "email.delivered");
    expect(await postEvent(app, late)).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    const failed = await auth(user, request(app).get(`/api/report-requests/${requestId}`));
    expect(failed.body).toMatchObject({
      status: "failed", sentAt: null, canRetry: true,
      failure: { code: "delivery_timeout", stage: "email_submission" },
    });
    expect(await prisma.providerEvent.count({ where: { providerEventId: "event-after-timeout" } })).toBe(1);
    expect((await prisma.reportDelivery.findUniqueOrThrow({ where: { reportRequestId: requestId } })).confirmedAt).toBeNull();
    expect(observed.metrics.snapshot().counters.some((metric) => metric.name === "report_deadline_failures_total")).toBe(true);

    const timedOutFailure = await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } });
    const retry = await auth(user, request(app).post(`/api/report-requests/${requestId}/retries`)).send({
      clientRequestId: randomUUID(),
    });
    expect(retry.status).toBe(202);
    const retryId = retry.body.id as string;
    const recoveryProvider = new SignedFakeProvider(clock);
    const recovery = makeServices(clock, { provider: recoveryProvider, telemetry: observed.telemetry });
    const recoveryApp = buildApp(recovery);
    await expect(recovery.worker("delivery-timeout-retry").runOnce()).resolves.toEqual({
      disposition: "acknowledged",
      reportRequestId: retryId,
    });
    const retryMessageId = recoveryProvider.logicalMessages.get(`report:${retryId}`)!.providerMessageId;
    expect(await postEvent(
      recoveryApp,
      signedEvent(clock, "event-timeout-retry-delivered", retryMessageId, "email.delivered"),
    )).toMatchObject({ status: 200, body: { received: true, duplicate: false } });
    expect(await auth(user, request(recoveryApp).get(`/api/report-requests/${retryId}`))).toMatchObject({
      status: 200,
      body: expect.objectContaining({ status: "sent", failure: null, canRetry: false }),
    });
    expect(await prisma.reportRequest.findUniqueOrThrow({ where: { id: requestId } })).toEqual(timedOutFailure);
    expect(observed.metrics.snapshot().counters.some((metric) =>
      metric.name === "report_retries_total" && metric.labels.reportRequestId === retryId
    )).toBe(true);
  });

  it("survives a process restart and retries provider ambiguity as one logical email", async () => {
    const clock = new MutableClock();
    const provider = new SignedFakeProvider(clock);
    provider.mode = "ambiguous_once";
    const firstProcess = makeServices(clock, { provider });
    const app = buildApp(firstProcess);
    const user = await createUser();
    await addEntry(user.id, { restaurantName: "Restart Original" });
    const created = await createRequest(app, user);
    const requestId = created.body.id as string;

    await expect(firstProcess.worker("process-one").runOnce()).resolves.toEqual({
      disposition: "retry_scheduled", reportRequestId: requestId,
      availableAt: new Date(START.getTime() + 10),
    });
    const beforeRestart = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: requestId }, include: { snapshot: true, attachment: true, delivery: true },
    });
    expect(beforeRestart).toMatchObject({
      status: ReportStatus.EMAIL_SUBMITTED,
      snapshot: expect.objectContaining({ reportRequestId: requestId }),
      attachment: expect.objectContaining({ reportRequestId: requestId }),
      delivery: expect.objectContaining({ idempotencyKey: `report:${requestId}`, acceptedAt: null }),
    });

    await prisma.deliveryEntry.updateMany({ where: { userId: user.id }, data: { restaurantName: "Restart Mutation" } });
    clock.advance(10);
    const restartedProcess = makeServices(clock, { provider });
    await expect(restartedProcess.worker("process-two").runOnce()).resolves.toEqual({
      disposition: "acknowledged", reportRequestId: requestId,
    });
    expect(provider.calls).toHaveLength(2);
    expect(new Set(provider.calls.map((call) => call.idempotencyKey))).toEqual(new Set([`report:${requestId}`]));
    expect(provider.logicalMessages.size).toBe(1);
    expect(await prisma.reportDelivery.count({ where: { reportRequestId: requestId } })).toBe(1);
    const afterRestart = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: requestId }, include: { snapshot: true, attachment: true },
    });
    expect(afterRestart.status).toBe(ReportStatus.EMAIL_ACCEPTED);
    expect(afterRestart.snapshot?.id).toBe(beforeRestart.snapshot?.id);
    expect(afterRestart.attachment?.sha256).toBe(beforeRestart.attachment?.sha256);
    expect(Buffer.from(afterRestart.attachment!.content)).toEqual(Buffer.from(beforeRestart.attachment!.content));
    expect(Buffer.from(afterRestart.attachment!.content).toString("utf8")).toContain("Restart Original");
    expect(Buffer.from(afterRestart.attachment!.content).toString("utf8")).not.toContain("Restart Mutation");
  });
});
