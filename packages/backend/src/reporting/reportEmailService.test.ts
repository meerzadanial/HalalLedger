import {
  Prisma,
  PrismaClient,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock, IdGenerator } from "./infrastructure";
import {
  REPORT_DELIVERY_DEADLINE_SECONDS,
  REPORT_EMAIL_BODY_LIMIT,
  REPORT_EMAIL_SUBJECT_LIMIT,
  ReportEmailService,
} from "./reportEmailService";
import {
  EmailProviderSubmissionError,
  type EmailProvider,
  type EmailProviderCommand,
} from "./provider";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";
const SUBMITTED_AT = new Date("2025-01-15T10:20:30.250Z");
const ACCEPTED_AT = new Date("2025-01-15T10:20:31.500Z");

function requestFixture() {
  return {
    id: REQUEST_ID,
    accountEmail: "persisted@example.com",
    reportType: ReportType.WEEKLY,
    periodStart: new Date("2025-01-06T00:00:00.000Z"),
    periodEnd: new Date("2025-01-12T00:00:00.000Z"),
    status: ReportStatus.PROCESSING,
    sentAt: null,
    snapshot: {
      recordCount: 3,
      digitalIncomeTotal: new Prisma.Decimal("30.25"),
      cashIncomeTotal: new Prisma.Decimal("5.00"),
      halalIncomeTotal: new Prisma.Decimal("25.25"),
      nonHalalIncomeTotal: new Prisma.Decimal("10.00"),
    },
    attachment: {
      content: Buffer.from("persisted,csv\r\n", "utf8"),
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: "text/csv; charset=UTF-8",
    },
    delivery: null as Delivery | null,
  };
}

type RequestFixture = ReturnType<typeof requestFixture>;
type Delivery = {
  id: string;
  reportRequestId: string;
  idempotencyKey: string;
  providerMessageId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  deliveryDeadlineAt: Date | null;
  confirmedAt: Date | null;
};

function makeHarness(providerSubmit?: EmailProvider["submit"]) {
  const request = requestFixture();
  const deliveries: Delivery[] = [];
  const failureRecorder = { recordFailure: vi.fn(async () => null) };
  const submittedCommands: EmailProviderCommand[] = [];
  const submit = providerSubmit ?? vi.fn(async (command: EmailProviderCommand) => {
    submittedCommands.push(command);
    return {
      providerMessageId: "provider-message-1",
      acceptedAt: new Date(ACCEPTED_AT),
    };
  });
  const provider: EmailProvider = {
    submit,
    verifyWebhook: vi.fn(() => {
      throw new Error("not used");
    }),
  };
  const tx = createTransaction(request, deliveries);
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
  const clock: Clock = { now: () => new Date(SUBMITTED_AT) };
  const ids: IdGenerator = { generate: () => DELIVERY_ID };
  const service = new ReportEmailService(
    prisma as unknown as PrismaClient,
    provider,
    clock,
    failureRecorder,
    ids,
  );
  return {
    service,
    request,
    deliveries,
    failureRecorder,
    submittedCommands,
    submit,
    tx,
  };
}

function createTransaction(request: RequestFixture, deliveries: Delivery[]) {
  const reportRequest = {
    findUnique: vi.fn(async () => request),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.id !== request.id || where.status !== request.status) {
        return { count: 0 };
      }
      Object.assign(request, data);
      return { count: 1 };
    }),
  };
  const reportDelivery = {
    create: vi.fn(async ({ data }: any) => {
      const delivery: Delivery = {
        ...data,
        providerMessageId: null,
        acceptedAt: null,
        confirmedAt: null,
      };
      deliveries.push(delivery);
      request.delivery = delivery;
      return delivery;
    }),
    update: vi.fn(async ({ data }: any) => {
      if (request.delivery === null) {
        throw new Error("missing delivery");
      }
      Object.assign(request.delivery, data);
      return request.delivery;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (
        request.delivery === null ||
        where.reportRequestId !== request.id ||
        (where.acceptedAt === null && request.delivery.acceptedAt !== null)
      ) {
        return { count: 0 };
      }
      Object.assign(request.delivery, data);
      return { count: 1 };
    }),
    findUnique: vi.fn(async () => request.delivery),
  };
  return { reportRequest, reportDelivery };
}

describe("ReportEmailService", () => {
  it("submits one persisted recipient and attachment and records acceptance without sent", async () => {
    const harness = makeHarness();

    const result = await harness.service.submit(REQUEST_ID);

    expect(result).toEqual({
      disposition: "accepted",
      status: "email_accepted",
      providerMessageId: "provider-message-1",
      submittedAt: SUBMITTED_AT,
      acceptedAt: ACCEPTED_AT,
      deliveryDeadlineAt: new Date(
        SUBMITTED_AT.getTime() + REPORT_DELIVERY_DEADLINE_SECONDS * 1_000,
      ),
    });
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0]).toMatchObject({
      reportRequestId: REQUEST_ID,
      idempotencyKey: `report:${REQUEST_ID}`,
      submittedAt: SUBMITTED_AT,
      acceptedAt: ACCEPTED_AT,
      providerMessageId: "provider-message-1",
    });
    expect(harness.request.status).toBe(ReportStatus.EMAIL_ACCEPTED);
    expect(harness.request.sentAt).toBeNull();
  });

  it("builds bounded subject and body values only from persisted report data", async () => {
    const harness = makeHarness();
    await harness.service.submit(REQUEST_ID);

    const [command] = harness.submittedCommands;
    expect(command.to).toEqual(["persisted@example.com"]);
    expect(command).not.toHaveProperty("from");
    expect(command.idempotencyKey).toBe(`report:${REQUEST_ID}`);
    expect(command.subject).toBe(
      "Weekly Report: 2025-01-06 to 2025-01-12",
    );
    expect(command.subject.length).toBeLessThanOrEqual(
      REPORT_EMAIL_SUBJECT_LIMIT,
    );
    expect(command.textBody).toBe([
      "Report Type: weekly",
      "Period Start: 2025-01-06",
      "Period End: 2025-01-12",
      "Delivery Record Count: 3",
      "Digital Income Total: 30.25",
      "Cash Income Total: 5.00",
      "Halal Income Total: 25.25",
      "Non-Halal Income Total: 10.00",
    ].join("\n"));
    expect(command.textBody.length).toBeLessThanOrEqual(
      REPORT_EMAIL_BODY_LIMIT,
    );
    expect(command.attachment).toEqual({
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: "text/csv; charset=UTF-8",
      bytes: new Uint8Array(Buffer.from("persisted,csv\r\n", "utf8")),
    });
    expect(command).not.toHaveProperty("attachments");
  });

  it("rejects an over-limit body before creating a delivery or calling the provider", async () => {
    const harness = makeHarness();
    harness.request.snapshot.digitalIncomeTotal = new Prisma.Decimal(
      "9".repeat(REPORT_EMAIL_BODY_LIMIT),
    );

    await expect(harness.service.submit(REQUEST_ID)).rejects.toMatchObject({
      code: "email_submission_failed",
      stage: "email_submission",
    });

    expect(harness.submit).not.toHaveBeenCalled();
    expect(harness.deliveries).toHaveLength(0);
    expect(harness.request.status).toBe(ReportStatus.PROCESSING);
  });

  it("maps an untyped adapter failure to a safe email-submission error", async () => {
    const harness = makeHarness(vi.fn(async () => {
      throw new Error("provider-token=must-not-escape");
    }));

    let caught: unknown;
    try {
      await harness.service.submit(REQUEST_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "email_submission_failed",
      stage: "email_submission",
      message: "Report email submission failed.",
    });
    expect(JSON.stringify(caught)).not.toContain("must-not-escape");
    expect(harness.request.status).toBe(ReportStatus.EMAIL_SUBMITTED);
    expect(harness.request.sentAt).toBeNull();
  });

  it("retains one acceptance and does not resubmit an accepted request", async () => {
    const harness = makeHarness();
    await harness.service.submit(REQUEST_ID);

    const replay = await harness.service.submit(REQUEST_ID);

    expect(replay).toMatchObject({
      disposition: "already_accepted",
      status: "email_accepted",
      providerMessageId: "provider-message-1",
    });
    expect(harness.submit).toHaveBeenCalledOnce();
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.request.sentAt).toBeNull();
  });

  it("reuses the sole delivery row, original deadline, and key after a transient failure", async () => {
    const providerSubmit = vi.fn()
      .mockRejectedValueOnce(
        new EmailProviderSubmissionError("unavailable", {
          cause: new Error("provider credential secret"),
        }),
      )
      .mockResolvedValueOnce({
        providerMessageId: "provider-message-1",
        acceptedAt: ACCEPTED_AT,
      });
    const harness = makeHarness(providerSubmit);

    await expect(harness.service.submit(REQUEST_ID)).rejects.toMatchObject({
      code: "provider_unavailable",
      retry: "transient",
    });
    const originalDeadline = harness.deliveries[0].deliveryDeadlineAt;
    const result = await harness.service.submit(REQUEST_ID);

    expect(result?.status).toBe("email_accepted");
    expect(harness.deliveries).toHaveLength(1);
    expect(harness.deliveries[0].deliveryDeadlineAt).toEqual(originalDeadline);
    expect(providerSubmit).toHaveBeenCalledTimes(2);
    expect(providerSubmit.mock.calls[0][0].idempotencyKey).toBe(
      `report:${REQUEST_ID}`,
    );
    expect(providerSubmit.mock.calls[1][0].idempotencyKey).toBe(
      `report:${REQUEST_ID}`,
    );
    expect(harness.failureRecorder.recordFailure).not.toHaveBeenCalled();
  });

  it("maps a definitive provider rejection to one safe terminal failure", async () => {
    const providerSubmit = vi.fn(async () => {
      throw new EmailProviderSubmissionError("rejected", {
        cause: new Error("api-key=do-not-expose"),
      });
    });
    const harness = makeHarness(providerSubmit);

    let caught: unknown;
    try {
      await harness.service.submit(REQUEST_ID);
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "provider_rejected",
      stage: "email_submission",
      message: "The email provider rejected the report email.",
      retry: "never",
    });
    expect(JSON.stringify(caught)).not.toContain("do-not-expose");
    expect(harness.failureRecorder.recordFailure).toHaveBeenCalledOnce();
    expect(harness.failureRecorder.recordFailure.mock.calls[0][0]).toMatchObject({
      reportRequestId: REQUEST_ID,
      failure: { code: "provider_rejected" },
      fromStatuses: ["email_submitted", "email_accepted"],
    });
    expect(harness.request.status).toBe(ReportStatus.EMAIL_SUBMITTED);
    expect(harness.request.sentAt).toBeNull();
  });
});
