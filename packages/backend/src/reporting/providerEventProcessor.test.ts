import { ReportStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import type { VerifiedProviderEvent } from "./models";
import { ProviderEventProcessor } from "./providerEventProcessor";

const REQUEST_ID = "request-1";
const MESSAGE_ID = "message-1";
const NOW = new Date("2025-01-15T10:05:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };

function event(
  eventType: VerifiedProviderEvent["eventType"] = "delivered",
): VerifiedProviderEvent {
  return {
    providerEventId: `event-${eventType}`,
    providerMessageId: MESSAGE_ID,
    eventType,
    occurredAt: new Date("2025-01-15T10:04:00.000Z"),
    payloadDigest: "a".repeat(64),
  };
}

function request(status: ReportStatus) {
  return {
    id: REQUEST_ID,
    userId: "user-1",
    status,
    progressStage: "delivery_wait",
  };
}

type StoredDelivery = {
  id: string;
  acceptedAt: Date | null;
  confirmedAt: Date | null;
  reportRequest: ReturnType<typeof request>;
};

function delivery(
  status = ReportStatus.EMAIL_ACCEPTED,
  overrides: Partial<Omit<StoredDelivery, "reportRequest">> = {},
): StoredDelivery {
  return {
    id: "delivery-1",
    acceptedAt: new Date("2025-01-15T10:00:00.000Z"),
    confirmedAt: null,
    ...overrides,
    reportRequest: request(status),
  };
}

function makeHarness(storedDelivery: StoredDelivery | null) {
  const tx = {
    providerEvent: { create: vi.fn().mockResolvedValue({}) },
    reportDelivery: {
      findUnique: vi.fn().mockResolvedValue(storedDelivery),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    reportRequest: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    reportJob: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx)),
  };
  const processor = new ProviderEventProcessor(
    prisma as never,
    clock,
  );
  return { processor, prisma, tx };
}

describe("ProviderEventProcessor", () => {
  it("stores delivery and atomically confirms only an accepted request", async () => {
    const { processor, tx } = makeHarness(delivery());

    await expect(processor.process(event())).resolves.toEqual({
      disposition: "stored",
      outcome: "sent",
    });
    expect(tx.providerEvent.create).toHaveBeenCalledWith({ data: event() });
    expect(tx.reportRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: ReportStatus.EMAIL_ACCEPTED },
      data: {
        status: ReportStatus.SENT,
        progressStage: "delivery_wait",
        sentAt: event().occurredAt,
      },
    });
    expect(tx.reportDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: "delivery-1",
        acceptedAt: { not: null },
        confirmedAt: null,
      },
      data: { confirmedAt: event().occurredAt },
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it.each(["failed", "bounced", "suppressed"] as const)(
    "stores %s and fails an unconfirmed request",
    async (eventType) => {
      const { processor, tx } = makeHarness(delivery());
      await expect(processor.process(event(eventType))).resolves.toEqual({
        disposition: "stored",
        outcome: "failed",
      });
      expect(tx.reportRequest.updateMany).toHaveBeenCalledWith({
        where: { id: REQUEST_ID, status: ReportStatus.EMAIL_ACCEPTED },
        data: expect.objectContaining({
          status: ReportStatus.FAILED,
          failureCode: "provider_rejected",
        }),
      });
    },
  );

  it("fails a rejected submission before provider acceptance", async () => {
    const submitted = makeHarness(delivery(
      ReportStatus.EMAIL_SUBMITTED,
      { acceptedAt: null },
    ));

    await expect(submitted.processor.process(event("failed"))).resolves.toEqual({
      disposition: "stored",
      outcome: "failed",
    });
    expect(submitted.tx.reportRequest.updateMany).toHaveBeenCalledWith({
      where: { id: REQUEST_ID, status: ReportStatus.EMAIL_SUBMITTED },
      data: expect.objectContaining({
        status: ReportStatus.FAILED,
        failureCode: "provider_rejected",
      }),
    });
  });

  it("retains an out-of-order delivery before acceptance without marking sent", async () => {
    const submitted = makeHarness(delivery(
      ReportStatus.EMAIL_SUBMITTED,
      { acceptedAt: null },
    ));

    await expect(submitted.processor.process(event())).resolves.toEqual({
      disposition: "stored",
      outcome: "ignored",
    });
    expect(submitted.tx.providerEvent.create).toHaveBeenCalledWith({
      data: event(),
    });
    expect(submitted.tx.reportRequest.updateMany).not.toHaveBeenCalled();
    expect(submitted.tx.reportDelivery.updateMany).not.toHaveBeenCalled();
    expect(submitted.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it.each(["delivered", "failed"] as const)(
    "retains a %s event after sent as a terminal no-op",
    async (eventType) => {
      const terminal = makeHarness(delivery(
        ReportStatus.SENT,
        { confirmedAt: new Date("2025-01-15T10:03:00.000Z") },
      ));

      await expect(terminal.processor.process(event(eventType))).resolves.toEqual({
        disposition: "stored",
        outcome: "ignored",
      });
      expect(terminal.tx.providerEvent.create).toHaveBeenCalledWith({
        data: event(eventType),
      });
      expect(terminal.tx.reportRequest.updateMany).not.toHaveBeenCalled();
      expect(terminal.tx.reportDelivery.updateMany).not.toHaveBeenCalled();
      expect(terminal.tx.auditLog.create).not.toHaveBeenCalled();
    },
  );

  it("retains a late confirmation for a timed-out request as diagnostic data", async () => {
    const terminal = makeHarness(delivery(ReportStatus.FAILED));

    await expect(terminal.processor.process(event())).resolves.toEqual({
      disposition: "stored",
      outcome: "ignored",
    });
    expect(terminal.tx.providerEvent.create).toHaveBeenCalledWith({
      data: event(),
    });
    expect(terminal.tx.reportRequest.updateMany).not.toHaveBeenCalled();
    expect(terminal.tx.reportDelivery.updateMany).not.toHaveBeenCalled();
    expect(terminal.tx.auditLog.create).not.toHaveBeenCalled();
  });

  it("retains unmatched events without changing report state", async () => {
    const unmatched = makeHarness(null);
    await expect(unmatched.processor.process(event())).resolves.toEqual({
      disposition: "stored",
      outcome: "ignored",
    });
    expect(unmatched.tx.reportRequest.updateMany).not.toHaveBeenCalled();
  });

  it("treats a provider-event uniqueness race as a successful duplicate", async () => {
    const { processor, prisma } = makeHarness(delivery());
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" });

    await expect(processor.process(event())).resolves.toEqual({
      disposition: "duplicate",
      outcome: "ignored",
    });
  });

  it("propagates database failures so the webhook can request a retry", async () => {
    const { processor, prisma } = makeHarness(delivery());
    prisma.$transaction.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(processor.process(event())).rejects.toThrow(
      "database unavailable",
    );
  });
});
