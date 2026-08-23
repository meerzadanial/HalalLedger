import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ReportDomainError,
  ReportInProgressError,
  ReportPeriodResolver,
  type Clock,
  type ReportRequestDto,
} from "../reporting";
import {
  createReportRouter,
  type ReportRouteServices,
  type ReportRouterDependencies,
} from "./reports";

const USER_ID = "user-1";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const CORRELATION_ID = "33333333-3333-4333-8333-333333333333";
const clock: Clock = { now: () => new Date("2025-01-15T00:00:00.000Z") };

const dto: ReportRequestDto = {
  id: REQUEST_ID,
  reportType: "weekly",
  referenceDate: "2025-01-08",
  period: { startDate: "2025-01-06", endDate: "2025-01-12", inclusive: true },
  accountEmail: "driver@example.com",
  status: "pending",
  progressStage: "data_retrieval",
  createdAt: "2025-01-08T10:00:00Z",
  providerAcceptedAt: null,
  sentAt: null,
  failure: null,
  canRetry: false,
};

function makeHarness() {
  const requestService = {
    create: vi.fn(), retry: vi.fn(), getActiveRequest: vi.fn(), getOwnedRequest: vi.fn(),
  };
  const services: ReportRouteServices = {
    periodResolver: new ReportPeriodResolver(clock),
    requestService,
    findAccount: vi.fn().mockResolvedValue({
      email: "driver@example.com", timeZone: "Asia/Kuala_Lumpur",
    }),
  };
  const dependencies: ReportRouterDependencies = {
    authenticate: vi.fn().mockResolvedValue({ userId: USER_ID, email: "driver@example.com" }),
    getServices: () => services,
    generateCorrelationId: () => CORRELATION_ID,
  };
  const app = express();
  app.use(express.json());
  app.use("/api", createReportRouter(dependencies));
  return { app, dependencies, services, requestService };
}

function authorized(call: request.Test): request.Test {
  return call.set("Authorization", "Bearer valid-token");
}

describe("report routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves an authenticated period with server-owned account fields", async () => {
    const { app, services } = makeHarness();
    const response = await authorized(request(app).get(
      "/api/report-periods/resolve?reportType=weekly&referenceDate=2025-01-08",
    )).set("x-correlation-id", CORRELATION_ID.toUpperCase());

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      reportType: "weekly",
      referenceDate: "2025-01-08",
      period: { startDate: "2025-01-06", endDate: "2025-01-12", inclusive: true },
      accountEmail: "driver@example.com",
      timeZone: "Asia/Kuala_Lumpur",
    });
    expect(response.headers["x-correlation-id"]).toBe(CORRELATION_ID);
    expect(services.findAccount).toHaveBeenCalledWith(USER_ID);
  });

  it("returns field-aware 400 validation errors", async () => {
    const { app } = makeHarness();
    const response = await authorized(request(app).get(
      "/api/report-periods/resolve?reportType=yearly&referenceDate=2025-01-08",
    ));
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "invalid_report_type",
      fieldErrors: { reportType: "Select weekly or monthly." },
      correlationId: CORRELATION_ID,
    });
  });

  it("returns the fixed report authentication contract without invoking services", async () => {
    const { app, dependencies } = makeHarness();
    const response = await request(app).get("/api/report-requests/active");
    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      code: "authentication_required",
      message: "Authentication is required to perform this report action.",
      correlationId: CORRELATION_ID,
    });
    expect(dependencies.authenticate).not.toHaveBeenCalled();
  });
  it("returns 202 for creation, 200 for replay, and passes only allowed command fields", async () => {
    const { app, requestService } = makeHarness();
    requestService.create
      .mockResolvedValueOnce({ disposition: "created", request: dto })
      .mockResolvedValueOnce({ disposition: "replayed", request: dto });
    const body = {
      reportType: "weekly", referenceDate: "2025-01-08", clientRequestId: CLIENT_ID,
      accountEmail: "attacker@example.com", status: "sent",
    };

    const created = await authorized(request(app).post("/api/report-requests")).send(body);
    const replayed = await authorized(request(app).post("/api/report-requests")).send(body);
    expect(created.status).toBe(202);
    expect(replayed.status).toBe(200);
    expect(created.body).toEqual(dto);
    expect(requestService.create).toHaveBeenCalledWith({
      userId: USER_ID,
      reportType: "weekly",
      referenceDate: "2025-01-08",
      clientRequestId: CLIENT_ID,
    });
  });

  it("maps an active-request conflict with its safe owned DTO", async () => {
    const { app, requestService } = makeHarness();
    requestService.create.mockRejectedValue(new ReportInProgressError(dto));
    const response = await authorized(request(app).post("/api/report-requests")).send({
      reportType: "weekly", referenceDate: "2025-01-08", clientRequestId: CLIENT_ID,
    });
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: "report_in_progress",
      activeRequest: dto,
      correlationId: CORRELATION_ID,
    });
  });

  it("returns the active DTO or 204 when no request is active", async () => {
    const { app, requestService } = makeHarness();
    requestService.getActiveRequest
      .mockResolvedValueOnce(dto)
      .mockResolvedValueOnce(null);
    const active = await authorized(request(app).get("/api/report-requests/active"));
    const empty = await authorized(request(app).get("/api/report-requests/active"));
    expect(active.status).toBe(200);
    expect(active.body).toEqual(dto);
    expect(empty.status).toBe(204);
    expect(empty.text).toBe("");
  });

  it("scopes status reads to the authenticated owner and hides missing or cross-user IDs", async () => {
    const { app, requestService } = makeHarness();
    requestService.getOwnedRequest
      .mockResolvedValueOnce(dto)
      .mockResolvedValueOnce(null);
    const found = await authorized(request(app).get(`/api/report-requests/${REQUEST_ID}`));
    const hidden = await authorized(request(app).get(`/api/report-requests/${REQUEST_ID}`));
    expect(found.status).toBe(200);
    expect(hidden.status).toBe(404);
    expect(hidden.body.code).toBe("report_not_found");
    expect(requestService.getOwnedRequest).toHaveBeenCalledWith(USER_ID, REQUEST_ID);
  });
  it("creates and replays owned retries with 202 and 200 semantics", async () => {
    const { app, requestService } = makeHarness();
    requestService.retry
      .mockResolvedValueOnce({ disposition: "created", request: dto })
      .mockResolvedValueOnce({ disposition: "replayed", request: dto });
    const created = await authorized(
      request(app).post(`/api/report-requests/${REQUEST_ID}/retries`),
    ).send({ clientRequestId: CLIENT_ID });
    const replayed = await authorized(
      request(app).post(`/api/report-requests/${REQUEST_ID}/retries`),
    ).send({ clientRequestId: CLIENT_ID });
    expect(created.status).toBe(202);
    expect(replayed.status).toBe(200);
    expect(requestService.retry).toHaveBeenCalledWith({
      userId: USER_ID, reportRequestId: REQUEST_ID, clientRequestId: CLIENT_ID,
    });
  });

  it("maps domain conflicts and unknown failures without exposing secrets", async () => {
    const conflict = makeHarness();
    conflict.requestService.retry.mockRejectedValue(
      new ReportDomainError("retry_not_allowed"),
    );
    const conflictResponse = await authorized(
      request(conflict.app).post(`/api/report-requests/${REQUEST_ID}/retries`),
    ).send({ clientRequestId: CLIENT_ID });
    expect(conflictResponse.status).toBe(409);
    expect(conflictResponse.body.code).toBe("retry_not_allowed");

    const unexpected = makeHarness();
    unexpected.requestService.create.mockRejectedValue(
      new Error("SESSION_TOKEN=secret provider-key=secret\nstack trace"),
    );
    const response = await authorized(
      request(unexpected.app).post("/api/report-requests"),
    ).send({ reportType: "weekly", referenceDate: "2025-01-08", clientRequestId: CLIENT_ID });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: "unexpected_report_error",
      stage: "unexpected",
      message: "The report could not be completed because of an unexpected error.",
      correlationId: CORRELATION_ID,
    });
    expect(JSON.stringify(response.body)).not.toContain("secret");
    expect(JSON.stringify(response.body)).not.toContain("stack trace");
  });

  it("does not intercept existing API routes mounted before the report router", async () => {
    const { dependencies } = makeHarness();
    const app = express();
    app.get("/api/existing-dashboard-data", (_req, res) => {
      res.status(200).json({ feature: "existing" });
    });
    app.use("/api", createReportRouter(dependencies));

    const existing = await request(app).get("/api/existing-dashboard-data");
    const report = await request(app).get("/api/report-requests/active");

    expect(existing.status).toBe(200);
    expect(existing.body).toEqual({ feature: "existing" });
    expect(report.status).toBe(401);
    expect(dependencies.authenticate).not.toHaveBeenCalled();
  });

  it("never reflects an unsafe supplied correlation value", async () => {
    const { app } = makeHarness();
    const response = await request(app)
      .get("/api/report-requests/active")
      .set("x-correlation-id", "secret-token-unsafe");
    expect(response.headers["x-correlation-id"]).toBe(CORRELATION_ID);
    expect(response.body.correlationId).toBe(CORRELATION_ID);
  });
});
