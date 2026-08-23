import {
  Prisma,
  PrismaClient,
  ReportStatus,
  ReportType,
} from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Clock, IdGenerator } from "./infrastructure";
import { ReportEmailService } from "./reportEmailService";
import type { EmailProvider, EmailProviderCommand } from "./provider";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const DELIVERY_ID = "22222222-2222-4222-8222-222222222222";
const SUBMITTED_AT = new Date("2025-01-15T10:20:30.000Z");
const APPLICABLE_NONTERMINAL_STATES = [
  ReportStatus.PROCESSING,
  ReportStatus.EMAIL_SUBMITTED,
  ReportStatus.EMAIL_ACCEPTED,
] as const;

type ApplicableStatus = (typeof APPLICABLE_NONTERMINAL_STATES)[number];
type StoredDelivery = {
  id: string;
  reportRequestId: string;
  idempotencyKey: string;
  providerMessageId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  deliveryDeadlineAt: Date | null;
  confirmedAt: Date | null;
};

type StoredRequest = ReturnType<typeof requestFixture>;
type ModelState = {
  request: StoredRequest;
  deliveries: StoredDelivery[];
  acceptanceWrites: number;
};

function requestFixture(status: ApplicableStatus) {
  return {
    id: REQUEST_ID,
    accountEmail: "persisted@example.com",
    reportType: ReportType.WEEKLY,
    periodStart: new Date("2025-01-06T00:00:00.000Z"),
    periodEnd: new Date("2025-01-12T00:00:00.000Z"),
    status,
    sentAt: null as Date | null,
    progressStage: status === ReportStatus.EMAIL_ACCEPTED
      ? "delivery_wait"
      : status === ReportStatus.EMAIL_SUBMITTED
        ? "email_submission"
        : "snapshot",
    snapshot: {
      recordCount: 1,
      digitalIncomeTotal: new Prisma.Decimal("10.00"),
      cashIncomeTotal: new Prisma.Decimal("0.00"),
      halalIncomeTotal: new Prisma.Decimal("10.00"),
      nonHalalIncomeTotal: new Prisma.Decimal("0.00"),
    },
    attachment: {
      content: Buffer.from("persisted,csv\r\n", "utf8"),
      filename: "weekly_2025-01-06_2025-01-12.csv",
      mediaType: "text/csv; charset=UTF-8",
    },
  };
}

class AcceptancePersistenceModel {
  private state: ModelState;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(
    status: ApplicableStatus,
    providerMessageId: string,
    acceptedAt: Date,
  ) {
    const accepted = status === ReportStatus.EMAIL_ACCEPTED;
    const submitted = status !== ReportStatus.PROCESSING;
    this.state = {
      request: requestFixture(status),
      deliveries: submitted
        ? [deliveryFixture(
            accepted ? providerMessageId : null,
            accepted ? acceptedAt : null,
          )]
        : [],
      acceptanceWrites: 0,
    };
  }

  readonly prisma = {
    $transaction: <T>(operation: (tx: unknown) => Promise<T>): Promise<T> => {
      const run = this.transactionTail.then(async () => {
        const draft = cloneState(this.state);
        const result = await operation(this.clientFor(draft));
        this.state = draft;
        return result;
      });
      this.transactionTail = run.then(() => undefined, () => undefined);
      return run;
    },
  };

  snapshot(): ModelState {
    return cloneState(this.state);
  }

  private clientFor(state: ModelState) {
    return {
      reportRequest: {
        findUnique: async () => ({
          ...state.request,
          delivery: state.deliveries[0] ?? null,
        }),
        updateMany: async ({ where, data }: any) => {
          if (where.id !== REQUEST_ID || where.status !== state.request.status) {
            return { count: 0 };
          }
          Object.assign(state.request, data);
          return { count: 1 };
        },
      },
      reportDelivery: {
        create: async ({ data }: any) => {
          if (state.deliveries.length !== 0) {
            throw new Error("duplicate report delivery");
          }
          const delivery: StoredDelivery = {
            ...data,
            providerMessageId: null,
            acceptedAt: null,
            confirmedAt: null,
          };
          state.deliveries.push(delivery);
          return delivery;
        },
        update: async ({ data }: any) => {
          const delivery = state.deliveries[0];
          if (!delivery) throw new Error("missing report delivery");
          Object.assign(delivery, data);
          return delivery;
        },
        updateMany: async ({ where, data }: any) => {
          const delivery = state.deliveries[0];
          if (
            !delivery ||
            where.reportRequestId !== REQUEST_ID ||
            (where.acceptedAt === null && delivery.acceptedAt !== null)
          ) {
            return { count: 0 };
          }
          Object.assign(delivery, data);
          state.acceptanceWrites += 1;
          return { count: 1 };
        },
        findUnique: async () => state.deliveries[0] ?? null,
      },
    };
  }
}

function deliveryFixture(
  providerMessageId: string | null,
  acceptedAt: Date | null,
): StoredDelivery {
  return {
    id: DELIVERY_ID,
    reportRequestId: REQUEST_ID,
    idempotencyKey: `report:${REQUEST_ID}`,
    providerMessageId,
    submittedAt: new Date(SUBMITTED_AT),
    acceptedAt: acceptedAt === null ? null : new Date(acceptedAt),
    deliveryDeadlineAt: new Date(SUBMITTED_AT.getTime() + 300_000),
    confirmedAt: null,
  };
}

function cloneState(state: ModelState): ModelState {
  return {
    request: {
      ...state.request,
      periodStart: new Date(state.request.periodStart),
      periodEnd: new Date(state.request.periodEnd),
      sentAt: state.request.sentAt === null ? null : new Date(state.request.sentAt),
      attachment: {
        ...state.request.attachment,
        content: Buffer.from(state.request.attachment.content),
      },
    },
    deliveries: state.deliveries.map((delivery) => ({
      ...delivery,
      submittedAt: copyNullableDate(delivery.submittedAt),
      acceptedAt: copyNullableDate(delivery.acceptedAt),
      deliveryDeadlineAt: copyNullableDate(delivery.deliveryDeadlineAt),
      confirmedAt: copyNullableDate(delivery.confirmedAt),
    })),
    acceptanceWrites: state.acceptanceWrites,
  };
}

function copyNullableDate(value: Date | null): Date | null {
  return value === null ? null : new Date(value);
}

const providerMessageIdArbitrary = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789"), {
    minLength: 1,
    maxLength: 24,
  })
  .map((characters) => `provider-${characters.join("")}`);

const acceptanceCaseArbitrary = fc.record({
  duplicateAcceptanceCount: fc.integer({ min: 1, max: 8 }),
  providerMessageId: providerMessageIdArbitrary,
  acceptedDelayMs: fc.integer({ min: 0, max: 299_999 }),
});

const clock: Clock = { now: () => new Date(SUBMITTED_AT) };
const ids: IdGenerator = { generate: () => DELIVERY_ID };

describe("ReportEmailService acceptance idempotency", () => {
  // Feature: bulk-csv-report-email, Property 17: Provider acceptance is idempotent
  // **Validates: Requirements 6.5, 6.11**
  it("retains one acceptance row and a safe state under duplicate provider acceptances", async () => {
    await fc.assert(fc.asyncProperty(
      acceptanceCaseArbitrary,
      async ({ duplicateAcceptanceCount, providerMessageId, acceptedDelayMs }) => {
        const acceptedAt = new Date(SUBMITTED_AT.getTime() + acceptedDelayMs);
        const acceptanceAttempts = duplicateAcceptanceCount + 1;

        for (const initialStatus of APPLICABLE_NONTERMINAL_STATES) {
          const model = new AcceptancePersistenceModel(
            initialStatus,
            providerMessageId,
            acceptedAt,
          );
          const returnedMessageIds: string[] = [];
          const provider: EmailProvider = {
            submit: async (_command: EmailProviderCommand) => {
              returnedMessageIds.push(providerMessageId);
              return { providerMessageId, acceptedAt: new Date(acceptedAt) };
            },
            verifyWebhook: () => {
              throw new Error("not used");
            },
          };
          const failureRecorder = { recordFailure: async () => null };
          const service = new ReportEmailService(
            model.prisma as unknown as PrismaClient,
            provider,
            clock,
            failureRecorder,
            ids,
          );

          const results = await Promise.all(Array.from(
            { length: acceptanceAttempts },
            () => service.submit(REQUEST_ID),
          ));
          const persisted = model.snapshot();
          const acceptedRows = persisted.deliveries.filter(
            (delivery) => delivery.acceptedAt !== null,
          );

          expect(persisted.deliveries).toHaveLength(1);
          expect(acceptedRows).toHaveLength(1);
          expect(acceptedRows[0]).toMatchObject({
            providerMessageId,
            acceptedAt,
          });
          expect(persisted.request.status).toBe(ReportStatus.EMAIL_ACCEPTED);
          expect(persisted.request.sentAt).toBeNull();
          expect(results.every(
            (result) => result?.providerMessageId === providerMessageId &&
              result.status === "email_accepted",
          )).toBe(true);

          if (initialStatus === ReportStatus.EMAIL_ACCEPTED) {
            expect(returnedMessageIds).toHaveLength(0);
            expect(persisted.acceptanceWrites).toBe(0);
            expect(results.every(
              (result) => result?.disposition === "already_accepted",
            )).toBe(true);
          } else {
            expect(returnedMessageIds).toEqual(
              Array(acceptanceAttempts).fill(providerMessageId),
            );
            expect(persisted.acceptanceWrites).toBe(1);
            expect(results.filter(
              (result) => result?.disposition === "accepted",
            )).toHaveLength(1);
          }

          const stateAfterAcceptance = model.snapshot();
          const replay = await service.submit(REQUEST_ID);
          expect(replay).toMatchObject({
            disposition: "already_accepted",
            status: "email_accepted",
            providerMessageId,
          });
          expect(model.snapshot()).toEqual(stateAfterAcceptance);
        }
      },
    ), { numRuns: 150 });
  });
});