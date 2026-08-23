import { PrismaClient, ReportStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { Clock } from "./infrastructure";
import { ReportArtifactRetentionService } from "./artifactRetention";

const NOW = new Date("2025-02-08T12:00:00.000Z");
const clock: Clock = { now: () => new Date(NOW) };

describe("ReportArtifactRetentionService", () => {
  it("deletes terminal attachments before and exactly at the retention boundary", async () => {
    const rows = [
      { id: "older-sent", generatedAt: new Date("2025-02-01T11:59:59.999Z"), status: ReportStatus.SENT },
      { id: "boundary-failed", generatedAt: new Date("2025-02-01T12:00:00.000Z"), status: ReportStatus.FAILED },
      { id: "newer-sent", generatedAt: new Date("2025-02-01T12:00:00.001Z"), status: ReportStatus.SENT },
      { id: "older-processing", generatedAt: new Date("2025-01-31T12:00:00.000Z"), status: ReportStatus.PROCESSING },
    ];
    const reportAttachment = {
      findMany: vi.fn().mockImplementation((query: {
        where: {
          generatedAt: { lte: Date };
          reportRequest: { is: { status: { in: ReportStatus[] } } };
        };
        take: number;
      }) => Promise.resolve(rows
        .filter((row) => row.generatedAt <= query.where.generatedAt.lte)
        .filter((row) => query.where.reportRequest.is.status.in.includes(row.status))
        .sort((left, right) => left.generatedAt.getTime() - right.generatedAt.getTime())
        .slice(0, query.take)
        .map(({ id }) => ({ id })))),
      deleteMany: vi.fn().mockResolvedValue({ count: 2 }),
    };
    const prisma = { reportAttachment } as unknown as PrismaClient;
    const service = new ReportArtifactRetentionService(
      prisma,
      { retentionDays: 7, batchSize: 25 },
      clock,
    );

    await expect(service.sweep()).resolves.toEqual({
      deletedAttachmentCount: 2,
      cutoff: new Date("2025-02-01T12:00:00.000Z"),
    });
    expect(reportAttachment.findMany).toHaveBeenCalledWith({
      where: {
        generatedAt: { lte: new Date("2025-02-01T12:00:00.000Z") },
        reportRequest: {
          is: { status: { in: [ReportStatus.SENT, ReportStatus.FAILED] } },
        },
      },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      take: 25,
      select: { id: true },
    });
    expect(reportAttachment.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["older-sent", "boundary-failed"] } },
    });
  });

  it("leaves request, snapshot, delivery, job, and audit metadata untouched", async () => {
    const reportAttachment = {
      findMany: vi.fn().mockResolvedValue([]),
      deleteMany: vi.fn(),
    };
    const metadataModels = {
      reportRequest: { deleteMany: vi.fn() },
      reportSnapshot: { deleteMany: vi.fn() },
      reportSnapshotEntry: { deleteMany: vi.fn() },
      reportDelivery: { deleteMany: vi.fn() },
      reportJob: { deleteMany: vi.fn() },
      auditLog: { deleteMany: vi.fn() },
    };
    const service = new ReportArtifactRetentionService(
      { reportAttachment, ...metadataModels } as unknown as PrismaClient,
      { retentionDays: 7 },
      clock,
    );

    await expect(service.sweep()).resolves.toMatchObject({
      deletedAttachmentCount: 0,
      cutoff: new Date("2025-02-01T12:00:00.000Z"),
    });
    expect(reportAttachment.deleteMany).not.toHaveBeenCalled();
    for (const model of Object.values(metadataModels)) {
      expect(model.deleteMany).not.toHaveBeenCalled();
    }
  });
});
