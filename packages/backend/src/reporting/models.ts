import type { Prisma } from "@prisma/client";
import type {
  ProviderEventType,
  ReportStatus,
  ReportType,
  ReportProgressStage,
} from "./constants";
import type { ReportDateString } from "./temporal";

export type RestaurantStatus = "halal" | "non-halal";

export interface ReportPeriod {
  readonly startDate: ReportDateString;
  readonly endDate: ReportDateString;
  readonly inclusive: true;
}

export interface ReportSummary {
  readonly recordCount: number;
  readonly digitalIncomeTotal: Prisma.Decimal;
  readonly cashIncomeTotal: Prisma.Decimal;
  readonly halalIncomeTotal: Prisma.Decimal;
  readonly nonHalalIncomeTotal: Prisma.Decimal;
}

export interface ReportSnapshotEntry {
  readonly sourceEntryId: string;
  readonly restaurantName: string;
  readonly restaurantStatus: RestaurantStatus;
  readonly fareAmount: Prisma.Decimal;
  readonly hasCashOrder: boolean;
  readonly cashAmount: Prisma.Decimal | null;
  readonly entryDate: ReportDateString;
  readonly entryTimestamp: Date;
}

export interface ReportSnapshot {
  readonly id: string;
  readonly reportRequestId: string;
  readonly reportType: ReportType;
  readonly period: ReportPeriod;
  readonly createdAt: Date;
  readonly entries: readonly ReportSnapshotEntry[];
  readonly summary: ReportSummary;
}

export interface ReportAttachment {
  readonly reportRequestId: string;
  readonly bytes: Uint8Array;
  readonly byteSize: number;
  readonly sha256: string;
  readonly filename: string;
  readonly mediaType: "text/csv; charset=UTF-8";
  readonly generatedAt: Date;
  readonly summary: ReportSummary;
}

export interface ReportRequestDomainRecord {
  readonly id: string;
  readonly userId: string;
  readonly retryOfId: string | null;
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriod;
  readonly accountEmail: string;
  readonly timeZone: string;
  readonly status: ReportStatus;
  readonly progressStage: ReportProgressStage;
  readonly createdAt: Date;
}

export interface VerifiedProviderEvent {
  readonly providerEventId: string;
  readonly providerMessageId: string;
  readonly eventType: ProviderEventType;
  readonly occurredAt: Date;
  readonly payloadDigest: string;
}
