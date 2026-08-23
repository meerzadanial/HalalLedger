import type { PrismaClient } from "@prisma/client";
import { Router, type NextFunction, type Request, type Response } from "express";
import { getDatabaseClient } from "../database";
import type { AuthenticatedRequest } from "../middleware/auth";
import {
  ReportDomainError,
  ReportPeriodResolver,
  ReportRequestService,
  SystemClock,
  REPORT_EVENTS,
  reportDurationMs,
  reportTelemetry,
  reportCorrelation,
  reportErrorHandler,
  type ReportDateString,
  type ReportTelemetry,
  type ReportType,
} from "../reporting";
import { getAuthenticationService } from "../services/AuthenticationService";

interface AuthenticatedReportUser {
  readonly userId: string;
  readonly email: string;
}

interface ReportAccount {
  readonly email: string;
  readonly timeZone: string;
}

export interface ReportRouteServices {
  readonly periodResolver: Pick<ReportPeriodResolver, "resolve">;
  readonly requestService: Pick<
    ReportRequestService,
    "create" | "retry" | "getActiveRequest" | "getOwnedRequest"
  >;
  findAccount(userId: string): Promise<ReportAccount | null>;
}

export interface ReportRouterDependencies {
  authenticate(token: string): Promise<AuthenticatedReportUser>;
  getServices(): ReportRouteServices;
  generateCorrelationId?: () => string;
  telemetry?: ReportTelemetry;
}

type AsyncRoute = (
  req: AuthenticatedRequest,
  res: Response,
) => Promise<void>;

const asyncRoute = (handler: AsyncRoute) =>
  (req: Request, res: Response, next: NextFunction): void => {
    void handler(req as AuthenticatedRequest, res).catch(next);
  };

/** Creates all authenticated report endpoints under the caller's `/api` mount. */
export function createReportRouter(
  dependencies: ReportRouterDependencies,
): Router {
  const router = Router();
  router.use(reportCorrelation(dependencies.generateCorrelationId));
  router.use((req, res, next) => {
    const startedAt = performance.now();
    res.once("finish", () => {
      (dependencies.telemetry ?? reportTelemetry).emit(REPORT_EVENTS.apiRequest, {
        requestId: String(res.locals.reportCorrelationId),
        operation: reportApiOperation(req.method, req.path),
        httpMethod: req.method,
        httpStatus: res.statusCode,
        durationMs: reportDurationMs(startedAt),
      });
    });
    next();
  });
  router.use((req, _res, next) => {
    void authenticateReportRequest(
      req as AuthenticatedRequest,
      dependencies,
    ).then(() => next(), next);
  });

  router.get("/report-periods/resolve", asyncRoute(async (req, res) => {
    const userId = requireAuthenticatedUser(req).userId;
    const services = dependencies.getServices();
    const account = await services.findAccount(userId);
    if (account === null) {
      throw new ReportDomainError("authentication_required");
    }
    const resolved = services.periodResolver.resolve({
      reportType: req.query.reportType,
      referenceDate: req.query.referenceDate,
      timeZone: account.timeZone,
    });
    res.status(200).json({
      ...resolved,
      accountEmail: account.email,
      timeZone: account.timeZone,
    });
  }));

  router.post("/report-requests", asyncRoute(async (req, res) => {
    const userId = requireAuthenticatedUser(req).userId;
    const body = isRecord(req.body) ? req.body : {};
    const result = await dependencies.getServices().requestService.create({
      userId,
      reportType: body.reportType as ReportType,
      referenceDate: body.referenceDate as ReportDateString,
      clientRequestId: body.clientRequestId as string,
    });
    res.status(result.disposition === "created" ? 202 : 200).json(result.request);
  }));

  router.get("/report-requests/active", asyncRoute(async (req, res) => {
    const userId = requireAuthenticatedUser(req).userId;
    const active = await dependencies.getServices().requestService
      .getActiveRequest(userId);
    if (active === null) {
      res.status(204).send();
      return;
    }
    res.status(200).json(active);
  }));

  router.get("/report-requests/:id", asyncRoute(async (req, res) => {
    const userId = requireAuthenticatedUser(req).userId;
    const report = await dependencies.getServices().requestService
      .getOwnedRequest(userId, req.params.id);
    if (report === null) {
      throw new ReportDomainError("report_not_found");
    }
    res.status(200).json(report);
  }));

  router.post("/report-requests/:id/retries", asyncRoute(async (req, res) => {
    const userId = requireAuthenticatedUser(req).userId;
    const body = isRecord(req.body) ? req.body : {};
    const result = await dependencies.getServices().requestService.retry({
      userId,
      reportRequestId: req.params.id,
      clientRequestId: body.clientRequestId as string,
    });
    res.status(result.disposition === "created" ? 202 : 200).json(result.request);
  }));

  router.use(reportErrorHandler);
  return router;
}

function requireAuthenticatedUser(req: AuthenticatedRequest): AuthenticatedReportUser {
  if (req.user === undefined) {
    throw new ReportDomainError("authentication_required");
  }
  return req.user;
}

async function authenticateReportRequest(
  req: AuthenticatedRequest,
  dependencies: ReportRouterDependencies,
): Promise<void> {
  const authorization = req.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  if (token.length === 0) {
    throw new ReportDomainError("authentication_required");
  }
  try {
    req.user = await dependencies.authenticate(token);
  } catch {
    throw new ReportDomainError("authentication_required");
  }
}

function reportApiOperation(method: string, path: string): string {
  if (path === "/report-periods/resolve") return "resolve_period";
  if (path === "/report-requests" && method === "POST") return "create_request";
  if (path === "/report-requests/active") return "get_active_request";
  if (path.endsWith("/retries")) return "retry_request";
  if (path.startsWith("/report-requests/")) return "get_request";
  return "report_api";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const clock = new SystemClock();
const periodResolver = new ReportPeriodResolver(clock);
let defaultPrisma: PrismaClient | undefined;
let defaultRequestService: ReportRequestService | undefined;

function getDefaultServices(): ReportRouteServices {
  const prisma = getDatabaseClient().getClient();
  if (defaultRequestService === undefined || defaultPrisma !== prisma) {
    defaultPrisma = prisma;
    defaultRequestService = new ReportRequestService(prisma, periodResolver, clock);
  }
  return {
    periodResolver,
    requestService: defaultRequestService,
    findAccount: async (userId) => prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, timeZone: true },
    }),
  };
}

const reportRoutes = createReportRouter({
  authenticate: (token) => getAuthenticationService().validateToken(token),
  getServices: getDefaultServices,
});

export default reportRoutes;
