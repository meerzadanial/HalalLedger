import { randomUUID } from "node:crypto";
import { PrismaClient, ReportStatus } from "@prisma/client";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ReportDomainError,
  ReportPeriodResolver,
  ReportRequestService,
  type Clock,
} from "../src/reporting";
import { createReportRouter } from "../src/routes/reports";

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined || !new URL(databaseUrl).pathname.includes("bulk_report_integration_")) {
  throw new Error("Report API integration tests require the generated disposable database.");
}

const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const NOW = new Date("2025-01-14T16:30:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };
const resolver = new ReportPeriodResolver(clock);
const service = new ReportRequestService(prisma, resolver, clock);
const authenticatedUsers = new Map<string, { userId: string; email: string }>();

const app = express();
app.use(express.json());
app.use("/api", createReportRouter({
  authenticate: async (token) => {
    const user = authenticatedUsers.get(token);
    if (user === undefined) throw new Error("invalid or expired session");
    return user;
  },
  getServices: () => ({
    periodResolver: resolver,
    requestService: service,
    findAccount: (userId) => prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, timeZone: true },
    }),
  }),
}));

interface TestUser {
  readonly id: string;
  readonly email: string;
  readonly token: string;
}

async function createUser(timeZone = "Asia/Kuala_Lumpur"): Promise<TestUser> {
  const id = randomUUID();
  const email = `${id}@example.test`;
  const token = `token-${id}`;
  await prisma.user.create({
    data: { id, email, passwordHash: "integration-only", timeZone },
  });
  authenticatedUsers.set(token, { userId: id, email });
  return { id, email, token };
}

function authorized(user: TestUser, call: request.Test): request.Test {
  return call.set("Authorization", `Bearer ${user.token}`);
}

function creationBody(overrides: Record<string, string> = {}) {
  return {
    reportType: "weekly",
    referenceDate: "2025-01-08",
    clientRequestId: randomUUID(),
    ...overrides,
  };
}

beforeAll(async () => prisma.$connect(), 30_000);
afterAll(async () => prisma.$disconnect(), 30_000);

describe("ReportPeriodResolver through the authenticated API", () => {
  it.each([
    ["known mid-week", "weekly", "2025-01-08", "2025-01-06", "2025-01-12"],
    ["known month end", "monthly", "2025-01-31", "2025-01-01", "2025-01-31"],
    ["Gregorian leap day", "monthly", "2024-02-29", "2024-02-01", "2024-02-29"],
    ["minimum supported year", "weekly", "0001-01-01", "0001-01-01", "0001-01-07"],
    ["account-local current date", "weekly", "2025-01-15", "2025-01-13", "2025-01-19"],
  ])("resolves %s inclusively", async (_name, reportType, referenceDate, startDate, endDate) => {
    const user = await createUser();
    const response = await authorized(
      user,
      request(app).get("/api/report-periods/resolve").query({ reportType, referenceDate }),
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      reportType,
      referenceDate,
      period: { startDate, endDate, inclusive: true },
      accountEmail: user.email,
      timeZone: "Asia/Kuala_Lumpur",
    });
  });

  it.each([
    ["missing_reference_date", { reportType: "weekly" }],
    ["invalid_reference_date", { reportType: "monthly", referenceDate: "2023-02-29" }],
    ["invalid_reference_date", { reportType: "weekly", referenceDate: "0000-12-31" }],
    ["future_reference_date", { reportType: "weekly", referenceDate: "2025-01-16" }],
  ])("rejects %s without creating a request", async (code, query) => {
    const user = await createUser();
    const response = await authorized(
      user,
      request(app).get("/api/report-periods/resolve").query(query),
    );

    expect(response.status).toBe(400);
    expect(response.body.code).toBe(code);
    expect(await prisma.reportRequest.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("ReportRequestService idempotency and active-request integration", () => {
  it("replays an identical key and rejects the same key with a conflicting selection", async () => {
    const user = await createUser();
    const clientRequestId = randomUUID();
    const body = creationBody({ clientRequestId });

    const created = await authorized(user, request(app).post("/api/report-requests")).send(body);
    const replayed = await authorized(user, request(app).post("/api/report-requests")).send(body);
    const conflict = await authorized(user, request(app).post("/api/report-requests")).send({
      ...body,
      reportType: "monthly",
    });

    expect(created.status).toBe(202);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(created.body);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe("idempotency_conflict");
    expect(await prisma.reportRequest.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.reportJob.count({
      where: { reportRequest: { userId: user.id } },
    })).toBe(1);
  });

  it("allows only one winner for concurrent active requests", async () => {
    const user = await createUser();
    const responses = await Promise.all([
      authorized(user, request(app).post("/api/report-requests")).send(creationBody()),
      authorized(user, request(app).post("/api/report-requests")).send(creationBody()),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([202, 409]);
    const blocked = responses.find(({ status }) => status === 409);
    expect(blocked?.body).toMatchObject({
      code: "report_in_progress",
      activeRequest: { accountEmail: user.email, status: "pending" },
    });
    expect(await prisma.reportRequest.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.reportJob.count({
      where: { reportRequest: { userId: user.id } },
    })).toBe(1);
  });

  it("returns authentication and command validation failures with zero persistence effects", async () => {
    const before = await Promise.all([
      prisma.reportRequest.count(),
      prisma.reportJob.count(),
      prisma.auditLog.count(),
    ]);
    const missing = await request(app).post("/api/report-requests").send(creationBody());
    const expired = await request(app)
      .post("/api/report-requests")
      .set("Authorization", "Bearer expired-token")
      .send(creationBody());

    expect(missing.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(missing.body.code).toBe("authentication_required");
    expect(expired.body.code).toBe("authentication_required");
    expect(await Promise.all([
      prisma.reportRequest.count(),
      prisma.reportJob.count(),
      prisma.auditLog.count(),
    ])).toEqual(before);

    const user = await createUser();
    const invalidType = await authorized(
      user,
      request(app).post("/api/report-requests"),
    ).send(creationBody({ reportType: "yearly" }));
    const invalidDate = await authorized(
      user,
      request(app).post("/api/report-requests"),
    ).send(creationBody({ referenceDate: "2025-02-30" }));

    expect(invalidType.status).toBe(400);
    expect(invalidType.body.code).toBe("invalid_report_type");
    expect(invalidDate.status).toBe(400);
    expect(invalidDate.body.code).toBe("invalid_reference_date");
    expect(await prisma.reportRequest.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.reportJob.count({
      where: { reportRequest: { userId: user.id } },
    })).toBe(0);
  });
});

describe("owned report request API DTOs and retries", () => {
  it("returns safe active/status DTOs and hides another user's request as 404", async () => {
    const owner = await createUser();
    const other = await createUser();
    const created = await authorized(
      owner,
      request(app).post("/api/report-requests"),
    ).send(creationBody());
    expect(created.status).toBe(202);

    const active = await authorized(owner, request(app).get("/api/report-requests/active"));
    const owned = await authorized(
      owner,
      request(app).get(`/api/report-requests/${created.body.id}`),
    );
    const hidden = await authorized(
      other,
      request(app).get(`/api/report-requests/${created.body.id}`),
    );

    expect(active.status).toBe(200);
    expect(owned.status).toBe(200);
    expect(active.body).toEqual(created.body);
    expect(owned.body).toEqual(created.body);
    expect(Object.keys(owned.body).sort()).toEqual([
      "accountEmail",
      "canRetry",
      "createdAt",
      "failure",
      "id",
      "period",
      "progressStage",
      "providerAcceptedAt",
      "referenceDate",
      "reportType",
      "sentAt",
      "status",
    ]);
    expect(owned.body).toMatchObject({
      accountEmail: owner.email,
      status: "pending",
      progressStage: "data_retrieval",
      providerAcceptedAt: null,
      sentAt: null,
      failure: null,
      canRetry: false,
      period: { startDate: "2025-01-06", endDate: "2025-01-12", inclusive: true },
    });
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("report_not_found");
    expect(await authorized(other, request(app).get("/api/report-requests/active")))
      .toMatchObject({ status: 204, text: "" });
  });

  it("creates one idempotent retry linked to an unchanged owned failed request", async () => {
    const owner = await createUser();
    const other = await createUser();
    const created = await authorized(
      owner,
      request(app).post("/api/report-requests"),
    ).send(creationBody({ reportType: "monthly", referenceDate: "2024-02-29" }));
    const failed = await service.recordFailure({
      reportRequestId: created.body.id,
      failure: new ReportDomainError("snapshot_failed"),
    });
    expect(failed?.status).toBe("failed");
    const originalBeforeRetry = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    const retryClientRequestId = randomUUID();

    const hidden = await authorized(
      other,
      request(app).post(`/api/report-requests/${created.body.id}/retries`),
    ).send({ clientRequestId: randomUUID() });
    const retried = await authorized(
      owner,
      request(app).post(`/api/report-requests/${created.body.id}/retries`),
    ).send({ clientRequestId: retryClientRequestId });
    const replayed = await authorized(
      owner,
      request(app).post(`/api/report-requests/${created.body.id}/retries`),
    ).send({ clientRequestId: retryClientRequestId });

    expect(hidden.status).toBe(404);
    expect(retried.status).toBe(202);
    expect(replayed.status).toBe(200);
    expect(replayed.body).toEqual(retried.body);
    expect(retried.body).toMatchObject({
      reportType: "monthly",
      referenceDate: "2024-02-29",
      accountEmail: owner.email,
      status: "pending",
    });
    const retryRow = await prisma.reportRequest.findUniqueOrThrow({
      where: { id: retried.body.id },
    });
    expect(retryRow.retryOfId).toBe(created.body.id);
    expect(await prisma.reportRequest.findUniqueOrThrow({
      where: { id: created.body.id },
    })).toEqual(originalBeforeRetry);
    expect(await prisma.reportRequest.count({
      where: { retryOfId: created.body.id },
    })).toBe(1);
  });
});

describe("ReportRequestService terminal compare-and-set behavior", () => {
  it("keeps failed and sent attempts terminal when stale or late operations arrive", async () => {
    const failedOwner = await createUser();
    const failedAttempt = await service.create({
      userId: failedOwner.id,
      ...creationBody(),
    });
    await service.recordFailure({
      reportRequestId: failedAttempt.request.id,
      failure: new ReportDomainError("delivery_timeout"),
    });
    const submittedAt = new Date("2025-01-15T00:00:00.000Z");
    await prisma.reportDelivery.create({
      data: {
        id: randomUUID(),
        reportRequestId: failedAttempt.request.id,
        idempotencyKey: `report:${failedAttempt.request.id}`,
        providerMessageId: randomUUID(),
        submittedAt,
        acceptedAt: new Date("2025-01-15T00:00:01.000Z"),
        deliveryDeadlineAt: new Date("2025-01-15T00:05:00.000Z"),
      },
    });
    const failedAuditCount = await prisma.auditLog.count({
      where: { entityId: failedAttempt.request.id, action: "report_request.terminal" },
    });

    expect(await service.markSent({
      reportRequestId: failedAttempt.request.id,
      confirmedAt: new Date("2025-01-15T00:00:02.000Z"),
    })).toBeNull();
    expect(await service.recordFailure({
      reportRequestId: failedAttempt.request.id,
      failure: new ReportDomainError("provider_rejected"),
    })).toBeNull();
    expect(await service.transitionNonterminal({
      reportRequestId: failedAttempt.request.id,
      fromStatuses: ["email_accepted"],
      toStatus: "processing",
      progressStage: "snapshot",
    })).toBeNull();
    expect(await prisma.reportRequest.findUniqueOrThrow({
      where: { id: failedAttempt.request.id },
      select: { status: true, failureCode: true, sentAt: true },
    })).toEqual({ status: ReportStatus.FAILED, failureCode: "delivery_timeout", sentAt: null });
    expect(await prisma.reportDelivery.findUniqueOrThrow({
      where: { reportRequestId: failedAttempt.request.id },
      select: { confirmedAt: true },
    })).toEqual({ confirmedAt: null });
    expect(await prisma.auditLog.count({
      where: { entityId: failedAttempt.request.id, action: "report_request.terminal" },
    })).toBe(failedAuditCount);

    const sentOwner = await createUser();
    const sentAttempt = await service.create({
      userId: sentOwner.id,
      ...creationBody(),
    });
    await prisma.reportRequest.update({
      where: { id: sentAttempt.request.id },
      data: { status: ReportStatus.EMAIL_ACCEPTED, progressStage: "delivery_wait" },
    });
    await prisma.reportDelivery.create({
      data: {
        id: randomUUID(),
        reportRequestId: sentAttempt.request.id,
        idempotencyKey: `report:${sentAttempt.request.id}`,
        providerMessageId: randomUUID(),
        submittedAt,
        acceptedAt: new Date("2025-01-15T00:00:01.000Z"),
        deliveryDeadlineAt: new Date("2025-01-15T00:05:00.000Z"),
      },
    });
    const sent = await service.markSent({
      reportRequestId: sentAttempt.request.id,
      confirmedAt: new Date("2025-01-15T00:00:02.000Z"),
    });
    expect(sent).toMatchObject({ status: "sent", canRetry: false });
    const sentAuditCount = await prisma.auditLog.count({
      where: { entityId: sentAttempt.request.id, action: "report_request.terminal" },
    });

    expect(await service.markSent({ reportRequestId: sentAttempt.request.id })).toBeNull();
    expect(await service.recordFailure({
      reportRequestId: sentAttempt.request.id,
      failure: new ReportDomainError("provider_rejected"),
    })).toBeNull();
    expect(await service.transitionNonterminal({
      reportRequestId: sentAttempt.request.id,
      fromStatuses: ["email_accepted"],
      toStatus: "processing",
      progressStage: "snapshot",
    })).toBeNull();
    expect(await prisma.reportRequest.findUniqueOrThrow({
      where: { id: sentAttempt.request.id },
      select: { status: true, sentAt: true, failureCode: true },
    })).toEqual({
      status: ReportStatus.SENT,
      sentAt: new Date("2025-01-15T00:00:02.000Z"),
      failureCode: null,
    });
    expect(await prisma.auditLog.count({
      where: { entityId: sentAttempt.request.id, action: "report_request.terminal" },
    })).toBe(sentAuditCount);
  });
});
