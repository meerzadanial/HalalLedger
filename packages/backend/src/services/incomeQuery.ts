import { Temporal } from "@js-temporal/polyfill";
import type { Prisma } from "@prisma/client";

export const MALAYSIA_TIME_ZONE = "Asia/Kuala_Lumpur";

export type DateOnly = string;
export type RestaurantStatus = "halal" | "non-halal";
export type PaymentType = "cash" | "digital" | "both";

export interface ExplicitDateRange {
  readonly startDate: DateOnly;
  readonly endDate: DateOnly;
}

export interface DashboardFilters {
  readonly dateRange?: ExplicitDateRange;
  readonly restaurantStatus?: RestaurantStatus;
  readonly paymentType?: PaymentType;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

const DATE_ONLY_PATTERN = /^(?!0000)(\d{4})-(\d{2})-(\d{2})$/;

function invalidDateOnly(value: unknown): RangeError {
  return new RangeError(
    `Invalid date-only value ${JSON.stringify(value)}; expected canonical YYYY-MM-DD`,
  );
}

function toPlainDate(value: DateOnly): Temporal.PlainDate {
  return Temporal.PlainDate.from(value, { overflow: "reject" });
}

export function parseDateOnly(value: unknown): DateOnly {
  if (typeof value !== "string" || !DATE_ONLY_PATTERN.test(value)) {
    throw invalidDateOnly(value);
  }

  try {
    const parsed = toPlainDate(value);
    if (parsed.toString() !== value) {
      throw invalidDateOnly(value);
    }
  } catch (error) {
    if (error instanceof RangeError && error.message.startsWith("Invalid date-only")) {
      throw error;
    }
    throw invalidDateOnly(value);
  }

  return value;
}
export function normalizeExplicitDateRange(
  startDate?: unknown,
  endDate?: unknown,
): ExplicitDateRange | undefined {
  if (startDate === undefined && endDate === undefined) {
    return undefined;
  }

  const start = parseDateOnly(startDate === undefined ? endDate : startDate);
  const end = parseDateOnly(endDate === undefined ? startDate : endDate);

  if (Temporal.PlainDate.compare(toPlainDate(start), toPlainDate(end)) > 0) {
    throw new RangeError("startDate must be on or before endDate");
  }

  return { startDate: start, endDate: end };
}

export function currentMalaysiaDate(clock: Clock = systemClock): DateOnly {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError("Clock returned an invalid instant");
  }

  return Temporal.Instant.fromEpochMilliseconds(now.getTime())
    .toZonedDateTimeISO(MALAYSIA_TIME_ZONE)
    .toPlainDate()
    .toString();
}

function toUtcDateCarrier(date: Temporal.PlainDate): Date {
  const carrier = new Date(0);
  carrier.setUTCHours(0, 0, 0, 0);
  carrier.setUTCFullYear(date.year, date.month - 1, date.day);
  return carrier;
}

export function toPrismaDateRange(
  range: ExplicitDateRange,
): Prisma.DateTimeFilter {
  const normalized = normalizeExplicitDateRange(
    range.startDate,
    range.endDate,
  );

  if (!normalized) {
    throw new RangeError("A date range is required");
  }

  const start = toPlainDate(normalized.startDate);
  const dayAfterEnd = toPlainDate(normalized.endDate).add({ days: 1 });

  return {
    gte: toUtcDateCarrier(start),
    lt: toUtcDateCarrier(dayAfterEnd),
  };
}

export function buildOwnedEntryWhere(
  userId: string,
  filters: DashboardFilters = {},
  effectiveDateRange?: ExplicitDateRange,
): Prisma.DeliveryEntryWhereInput {
  const range = effectiveDateRange ?? filters.dateRange;

  return {
    userId,
    ...(range && { entryDate: toPrismaDateRange(range) }),
    ...(filters.restaurantStatus && {
      restaurantStatus: filters.restaurantStatus,
    }),
    ...(filters.paymentType === "cash" && { hasCashOrder: true }),
    ...(filters.paymentType === "digital" && { hasCashOrder: false }),
  };
}
