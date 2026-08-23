import type { PrismaClient } from "@prisma/client";
import express, {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import { getDatabaseClient } from "../database";
import {
  ProviderEventProcessor,
  ReportDomainError,
  ResendEmailProvider,
  REPORT_EVENTS,
  loadReportOperationalConfig,
  reportDurationMs,
  reportTelemetry,
  reportCorrelation,
  reportErrorHandler,
  type EmailProvider,
  type ProviderWebhookHeaders,
  type ReportTelemetry,
} from "../reporting";

export interface ResendWebhookServices {
  readonly provider: Pick<EmailProvider, "verifyWebhook">;
  readonly processor: Pick<ProviderEventProcessor, "process">;
}

export interface ResendWebhookRouterDependencies {
  getServices(): ResendWebhookServices;
  generateCorrelationId?: () => string;
  telemetry?: ReportTelemetry;
}

/** Creates the public Resend endpoint with route-local raw body capture. */
export function createResendWebhookRouter(
  dependencies: ResendWebhookRouterDependencies,
): Router {
  const router = Router();
  router.use(reportCorrelation(dependencies.generateCorrelationId));
  router.use((req, res, next) => {
    const startedAt = performance.now();
    res.once("finish", () => {
      (dependencies.telemetry ?? reportTelemetry).emit(REPORT_EVENTS.apiRequest, {
        requestId: String(res.locals.reportCorrelationId),
        operation: "resend_webhook",
        httpMethod: req.method,
        httpStatus: res.statusCode,
        durationMs: reportDurationMs(startedAt),
      });
    });
    next();
  });
  router.post(
    "/",
    express.raw({ type: "application/json", limit: "1mb" }),
    (req, res, next) => void handleWebhook(req, res, next, dependencies),
  );
  router.use(reportErrorHandler);
  return router;
}

async function handleWebhook(
  req: Request,
  res: Response,
  next: NextFunction,
  dependencies: ResendWebhookRouterDependencies,
): Promise<void> {
  const telemetry = dependencies.telemetry ?? reportTelemetry;
  const requestId = typeof res.locals.reportCorrelationId === "string"
    ? res.locals.reportCorrelationId
    : undefined;
  const startedAt = performance.now();
  if (!Buffer.isBuffer(req.body)) {
    telemetry.emit(REPORT_EVENTS.webhookInvalid, {
      requestId,
      stage: "webhook",
      errorCode: "malformed_provider_event",
      durationMs: reportDurationMs(startedAt),
    });
    next(new ReportDomainError("malformed_provider_event"));
    return;
  }

  let event;
  try {
    const services = dependencies.getServices();
    event = services.provider.verifyWebhook(req.body, webhookHeaders(req));
  } catch (error) {
    telemetry.emit(REPORT_EVENTS.webhookInvalid, {
      requestId,
      stage: "webhook",
      errorCode: error instanceof ReportDomainError
        ? error.code
        : "unexpected_report_error",
      durationMs: reportDurationMs(startedAt),
    });
    next(error);
    return;
  }
  telemetry.emit(REPORT_EVENTS.webhookVerified, {
    requestId,
    providerEventId: event.providerEventId,
    providerMessageId: event.providerMessageId,
    eventType: event.eventType,
    stage: "webhook",
    durationMs: reportDurationMs(startedAt),
  });

  try {
    const result = await dependencies.getServices().processor.process(event);
    res.status(200).json({
      received: true,
      duplicate: result.disposition === "duplicate",
    });
  } catch (error) {
    next(new ReportDomainError("provider_event_persistence_failed", {
      cause: error,
    }));
  }
}

function webhookHeaders(req: Request): ProviderWebhookHeaders {
  return Object.fromEntries(
    Object.entries(req.headers).filter(
      (entry): entry is [string, string | string[]] =>
        entry[1] !== undefined,
    ),
  );
}

let defaultPrisma: PrismaClient | undefined;
let defaultProvider: ResendEmailProvider | undefined;
let defaultProcessor: ProviderEventProcessor | undefined;

function getDefaultServices(): ResendWebhookServices {
  const prisma = getDatabaseClient().getClient();
  if (defaultPrisma !== prisma || defaultProcessor === undefined) {
    defaultPrisma = prisma;
    defaultProcessor = new ProviderEventProcessor(prisma);
  }
  if (defaultProvider === undefined) {
    const config = loadReportOperationalConfig();
    defaultProvider = new ResendEmailProvider({
      apiKey: config.provider.apiKey ?? "",
      webhookSecret: config.provider.webhookSecret ?? "",
      fromEmail: config.provider.fromEmail ?? "",
    });
  }
  return { provider: defaultProvider, processor: defaultProcessor };
}

const resendWebhookRoutes = createResendWebhookRouter({
  getServices: getDefaultServices,
});

export default resendWebhookRoutes;
