import { PrismaClient, ReportStatus } from "@prisma/client";
import type { Clock } from "./infrastructure";
import { SystemClock } from "./infrastructure";

export interface ArtifactRetentionOptions {
  readonly retentionDays: number;
  readonly batchSize?: number;
}

export interface ArtifactRetentionResult {
  readonly deletedAttachmentCount: number;
  readonly cutoff: Date;
}

/**
 * Deletes only terminal CSV attachment rows. Request, snapshot, snapshot-entry,
 * delivery, provider-event, job, and audit metadata are deliberately untouched.
 */
export class ReportArtifactRetentionService {
  private readonly retentionDays: number;
  private readonly batchSize: number;

  constructor(
    private readonly prisma: PrismaClient,
    options: ArtifactRetentionOptions,
    private readonly clock: Clock = new SystemClock(),
  ) {
    this.retentionDays = positiveInteger(options.retentionDays, "retentionDays");
    this.batchSize = positiveInteger(options.batchSize ?? 100, "batchSize");
  }

  async sweep(): Promise<ArtifactRetentionResult> {
    const now = validDate(this.clock.now());
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000);
    const candidates = await this.prisma.reportAttachment.findMany({
      where: {
        generatedAt: { lte: cutoff },
        reportRequest: {
          is: { status: { in: [ReportStatus.SENT, ReportStatus.FAILED] } },
        },
      },
      orderBy: [{ generatedAt: "asc" }, { id: "asc" }],
      take: this.batchSize,
      select: { id: true },
    });
    if (candidates.length === 0) {
      return { deletedAttachmentCount: 0, cutoff };
    }

    const deleted = await this.prisma.reportAttachment.deleteMany({
      where: { id: { in: candidates.map(({ id }) => id) } },
    });
    return { deletedAttachmentCount: deleted.count, cutoff };
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("clock must return a valid Date");
  }
  return new Date(value);
}
