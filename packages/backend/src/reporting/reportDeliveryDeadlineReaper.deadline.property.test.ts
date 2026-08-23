import { PrismaClient, ReportStatus } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Clock } from "./infrastructure";
import { ProviderEventProcessor } from "./providerEventProcessor";
import { ReportDeliveryDeadlineReaper } from "./reportDeliveryDeadlineReaper";

const REQUEST_ID = "request-deadline-property";
const USER_ID = "user-deadline-property";
const MESSAGE_ID = "message-deadline-property";
const DEADLINE_MS = 300_000;
const TERMINAL = new Set<ReportStatus>([ReportStatus.SENT, ReportStatus.FAILED]);

type PendingDeliveryStatus =
  | typeof ReportStatus.EMAIL_SUBMITTED
  | typeof ReportStatus.EMAIL_ACCEPTED;

interface Scenario {
  submissionMs: number;
  observationDeltaMs: -1 | 0 | 1;
  initialStatus: PendingDeliveryStatus;
  confirmed: boolean;
  hasLateDeliveryEvent: boolean;
}

interface ExpectedOutcome {
  timedOut: boolean;
  afterSweep: ReportStatus;
  finalStatus: ReportStatus;
  finalConfirmed: boolean;
  lateEventOutcome?: "sent" | "ignored";
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  submissionMs: fc.integer({
    min: Date.UTC(2000, 0, 1),
    max: Date.UTC(2099, 11, 31, 23, 54, 59, 999),
  }),
  observationDeltaMs: fc.constantFrom(-1 as const, 0 as const, 1 as const),
  initialStatus: fc.constantFrom(
    ReportStatus.EMAIL_SUBMITTED,
    ReportStatus.EMAIL_ACCEPTED,
  ),
  confirmed: fc.boolean(),
  hasLateDeliveryEvent: fc.boolean(),
});

function expectedOutcome(scenario: Scenario): ExpectedOutcome {
  const deadlineMs = scenario.submissionMs + DEADLINE_MS;
  const observedMs = deadlineMs + scenario.observationDeltaMs;
  const initial = scenario.confirmed ? ReportStatus.SENT : scenario.initialStatus;
  const timedOut = !scenario.confirmed && observedMs >= deadlineMs;
  const afterSweep = timedOut ? ReportStatus.FAILED : initial;
  const lateEventOutcome = scenario.hasLateDeliveryEvent
    ? afterSweep === ReportStatus.EMAIL_ACCEPTED ? "sent" : "ignored"
    : undefined;
  const finalStatus = lateEventOutcome === "sent" ? ReportStatus.SENT : afterSweep;
  return {
    timedOut,
    afterSweep,
    finalStatus,
    finalConfirmed: scenario.confirmed || lateEventOutcome === "sent",
    lateEventOutcome,
  };
}

class TransactionalDeadlineState {
  readonly submittedAt: Date;
  readonly deadlineAt: Date;
  readonly acceptedAt: Date | null;
  confirmedAt: Date | null;
  status: ReportStatus;
  sentAt: Date | null = null;
  lastDeadlineQuery: { sql: string; values: unknown[] } | null = null;
  readonly seenProviderEvents = new Set<string>();
  readonly prisma: unknown;

  constructor(scenario: Scenario) {
    this.submittedAt = new Date(scenario.submissionMs);
    this.deadlineAt = new Date(scenario.submissionMs + DEADLINE_MS);
    this.acceptedAt = scenario.initialStatus === ReportStatus.EMAIL_ACCEPTED
      || scenario.confirmed
      ? new Date(scenario.submissionMs)
      : null;
    this.confirmedAt = scenario.confirmed
      ? new Date(scenario.submissionMs + 1)
      : null;
    this.status = scenario.confirmed ? ReportStatus.SENT : scenario.initialStatus;
    const tx = this.transactionClient();
    this.prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
    };
  }

  private transactionClient() {
    return {
      $queryRaw: async (query: { sql: string; values: unknown[] }) => {
        this.lastDeadlineQuery = query;
        const observedAt = query.values.find((value) => value instanceof Date);
        if (!(observedAt instanceof Date)) throw new Error("missing sweep instant");
        if (
          (this.status === ReportStatus.EMAIL_SUBMITTED
            || this.status === ReportStatus.EMAIL_ACCEPTED)
          && this.deadlineAt.getTime() <= observedAt.getTime()
          && this.confirmedAt === null
        ) {
          const statusFrom = this.status;
          this.status = ReportStatus.FAILED;
          return [{ id: REQUEST_ID, user_id: USER_ID, status_from: statusFrom }];
        }
        return [];
      },
      providerEvent: {
        create: async ({ data }: { data: { providerEventId: string } }) => {
          if (this.seenProviderEvents.has(data.providerEventId)) throw { code: "P2002" };
          this.seenProviderEvents.add(data.providerEventId);
          return data;
        },
      },
      reportDelivery: {
        findUnique: async () => ({
          id: "delivery-deadline-property",
          submittedAt: this.submittedAt,
          deliveryDeadlineAt: this.deadlineAt,
          acceptedAt: this.acceptedAt,
          confirmedAt: this.confirmedAt,
          reportRequest: {
            id: REQUEST_ID,
            userId: USER_ID,
            status: this.status,
            progressStage: "delivery_wait",
          },
        }),
        updateMany: async ({ data }: { data: { confirmedAt: Date } }) => {
          if (this.acceptedAt === null || this.confirmedAt !== null) return { count: 0 };
          this.confirmedAt = new Date(data.confirmedAt);
          return { count: 1 };
        },
      },
      reportRequest: {
        updateMany: async ({
          where,
          data,
        }: {
          where: { id: string; status: ReportStatus };
          data: { status: ReportStatus; sentAt?: Date };
        }) => {
          if (where.id !== REQUEST_ID || this.status !== where.status) return { count: 0 };
          this.status = data.status;
          if (data.sentAt !== undefined) this.sentAt = new Date(data.sentAt);
          return { count: 1 };
        },
      },
      reportJob: { updateMany: async () => ({ count: 1 }) },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
    };
  }
}


describe("Report delivery deadline", () => {
  // Feature: bulk-csv-report-email, Property 20: Delivery deadline is exact
  // **Validates: Requirements 6.13, 6.14**
  it("matches the exact 300-second boundary model and preserves terminal states", async () => {
    await fc.assert(fc.asyncProperty(scenarioArbitrary, async (scenario) => {
      const expected = expectedOutcome(scenario);
      const observedAt = new Date(
        scenario.submissionMs + DEADLINE_MS + scenario.observationDeltaMs,
      );
      const clock: Clock = { now: () => new Date(observedAt) };
      const state = new TransactionalDeadlineState(scenario);
      const reaper = new ReportDeliveryDeadlineReaper(
        state.prisma as PrismaClient,
        clock,
      );

      const sweep = await reaper.sweep();

      expect(sweep.timedOutCount).toBe(expected.timedOut ? 1 : 0);
      expect(sweep.reportRequestIds).toEqual(expected.timedOut ? [REQUEST_ID] : []);
      expect(state.status).toBe(expected.afterSweep);
      expect(state.lastDeadlineQuery?.sql).toContain(
        'delivery."delivery_deadline_at" <=',
      );
      expect(
        state.lastDeadlineQuery?.values
          .filter((value): value is Date => value instanceof Date)
          .every((value) => value.getTime() === observedAt.getTime()),
      ).toBe(true);

      if (scenario.hasLateDeliveryEvent) {
        const terminalBeforeLateEvent = TERMINAL.has(state.status)
          ? state.status
          : null;
        const processor = new ProviderEventProcessor(
          state.prisma as PrismaClient,
          clock,
        );
        const result = await processor.process({
          providerEventId: "late-delivery-event",
          providerMessageId: MESSAGE_ID,
          eventType: "delivered",
          occurredAt: new Date(observedAt.getTime() + 1),
          payloadDigest: "a".repeat(64),
        });

        expect(result).toEqual({
          disposition: "stored",
          outcome: expected.lateEventOutcome,
        });
        if (terminalBeforeLateEvent !== null) {
          expect(state.status).toBe(terminalBeforeLateEvent);
        }
      }

      expect(state.status).toBe(expected.finalStatus);
      expect(state.confirmedAt !== null).toBe(expected.finalConfirmed);
      if (expected.timedOut) expect(state.status).toBe(ReportStatus.FAILED);
    }), { numRuns: 150 });
  });
});