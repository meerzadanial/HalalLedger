import { ReportStatus } from "@prisma/client";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Clock } from "./infrastructure";
import type { VerifiedProviderEvent } from "./models";
import {
  ProviderEventProcessor,
  type ProviderEventProcessingResult,
} from "./providerEventProcessor";

const REQUEST_ID = "request-terminal-property";
const MESSAGE_ID = "message-terminal-property";
const ACCEPTED_AT = new Date("2025-01-15T10:00:00.000Z");
const clock: Clock = {
  now: () => new Date("2025-01-15T10:10:00.000Z"),
};
const EVENT_TYPES = ["delivered", "failed", "bounced", "suppressed"] as const;
const TERMINAL = new Set<ReportStatus>([ReportStatus.SENT, ReportStatus.FAILED]);

type EventType = VerifiedProviderEvent["eventType"];

interface InitialState {
  status: ReportStatus;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
}

interface ReferenceState {
  status: ReportStatus;
  accepted: boolean;
  confirmed: boolean;
  seenEventIds: Set<string>;
}

const initialStateArbitrary: fc.Arbitrary<InitialState> = fc.oneof(
  fc.constant({ status: ReportStatus.PENDING, acceptedAt: null, confirmedAt: null }),
  fc.constant({ status: ReportStatus.PROCESSING, acceptedAt: null, confirmedAt: null }),
  fc.constant({ status: ReportStatus.EMAIL_SUBMITTED, acceptedAt: null, confirmedAt: null }),
  fc.constant({ status: ReportStatus.EMAIL_ACCEPTED, acceptedAt: ACCEPTED_AT, confirmedAt: null }),
  fc.constant({ status: ReportStatus.SENT, acceptedAt: ACCEPTED_AT, confirmedAt: ACCEPTED_AT }),
  fc.boolean().map((accepted): InitialState => ({
    status: ReportStatus.FAILED,
    acceptedAt: accepted ? ACCEPTED_AT : null,
    confirmedAt: null,
  })),
);
const eventTraceArbitrary: fc.Arbitrary<VerifiedProviderEvent[]> = fc
  .tuple(
    fc.shuffledSubarray([...EVENT_TYPES], { minLength: 4, maxLength: 4 }),
    fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 1, maxLength: 8 }),
  )
  .chain(([types, duplicateIndexes]) => {
    const baseEvents = types.map((eventType, index): VerifiedProviderEvent => ({
      providerEventId: `provider-event-${index}`,
      providerMessageId: MESSAGE_ID,
      eventType,
      occurredAt: new Date(Date.UTC(2025, 0, 15, 10, index + 1)),
      payloadDigest: String(index).repeat(64),
    }));
    const expanded = [
      ...baseEvents,
      ...duplicateIndexes.map((index) => baseEvents[index]),
    ];
    return fc.shuffledSubarray(expanded, {
      minLength: expanded.length,
      maxLength: expanded.length,
    }).filter((trace) => trace.some((event, index) =>
      index > 0 && event.occurredAt < trace[index - 1].occurredAt));
  });

function transitionReference(
  state: ReferenceState,
  event: VerifiedProviderEvent,
): ProviderEventProcessingResult {
  if (state.seenEventIds.has(event.providerEventId)) {
    return { disposition: "duplicate", outcome: "ignored" };
  }
  state.seenEventIds.add(event.providerEventId);
  if (TERMINAL.has(state.status)) {
    return { disposition: "stored", outcome: "ignored" };
  }
  if (event.eventType === "delivered") {
    if (state.status === ReportStatus.EMAIL_ACCEPTED && state.accepted && !state.confirmed) {
      state.status = ReportStatus.SENT;
      state.confirmed = true;
      return { disposition: "stored", outcome: "sent" };
    }
    return { disposition: "stored", outcome: "ignored" };
  }
  if (
    !state.confirmed
    && (state.status === ReportStatus.EMAIL_SUBMITTED
      || state.status === ReportStatus.EMAIL_ACCEPTED)
  ) {
    state.status = ReportStatus.FAILED;
    return { disposition: "stored", outcome: "failed" };
  }
  return { disposition: "stored", outcome: "ignored" };
}

class TransactionalProviderState {
  readonly seenEventIds = new Set<string>();
  status: ReportStatus;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
  sentAt: Date | null = null;

  readonly prisma: unknown;

  constructor(initial: InitialState) {
    this.status = initial.status;
    this.acceptedAt = initial.acceptedAt;
    this.confirmedAt = initial.confirmedAt;
    const tx = this.transactionClient();
    this.prisma = {
      $transaction: async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx),
    };
  }
  private transactionClient() {
    return {
      providerEvent: {
        create: async ({ data }: { data: VerifiedProviderEvent }) => {
          if (this.seenEventIds.has(data.providerEventId)) throw { code: "P2002" };
          this.seenEventIds.add(data.providerEventId);
          return data;
        },
      },
      reportDelivery: {
        findUnique: async () => ({
          id: "delivery-terminal-property",
          acceptedAt: this.acceptedAt,
          confirmedAt: this.confirmedAt,
          reportRequest: {
            id: REQUEST_ID,
            userId: "user-terminal-property",
            status: this.status,
            progressStage: "delivery_wait",
          },
        }),
        updateMany: async ({ data }: { data: { confirmedAt: Date } }) => {
          if (this.acceptedAt === null || this.confirmedAt !== null) return { count: 0 };
          this.confirmedAt = data.confirmedAt;
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
          if (data.sentAt !== undefined) this.sentAt = data.sentAt;
          return { count: 1 };
        },
      },
      reportJob: { updateMany: async () => ({ count: 1 }) },
      auditLog: { create: async ({ data }: { data: unknown }) => data },
    };
  }
}

describe("ProviderEventProcessor terminal transitions", () => {
  // Feature: bulk-csv-report-email, Property 18: Delivery state transitions are terminal-safe
  // **Validates: Requirements 6.6, 6.8, 6.9, 6.14**
  it("matches an independent model for duplicate and out-of-order delivery event traces", async () => {
    await fc.assert(fc.asyncProperty(
      initialStateArbitrary,
      eventTraceArbitrary,
      async (initial, trace) => {
        const real = new TransactionalProviderState(initial);
        const processor = new ProviderEventProcessor(real.prisma as never, clock);
        const reference: ReferenceState = {
          status: initial.status,
          accepted: initial.acceptedAt !== null,
          confirmed: initial.confirmedAt !== null,
          seenEventIds: new Set(),
        };

        for (const event of trace) {
          const statusBefore = real.status;
          const expected = transitionReference(reference, event);
          const actual = await processor.process(event);

          expect(actual).toEqual(expected);
          expect(real.status).toBe(reference.status);
          expect(real.acceptedAt !== null).toBe(reference.accepted);
          expect(real.confirmedAt !== null).toBe(reference.confirmed);
          expect(real.seenEventIds).toEqual(reference.seenEventIds);
          if (TERMINAL.has(statusBefore)) expect(real.status).toBe(statusBefore);
        }
      },
    ), { numRuns: 150 });
  });
});
