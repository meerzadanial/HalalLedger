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

interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

const DATE_ONLY_PATTERN = /^(?!0000)(\d{4})-(\d{2})-(\d{2})$/;
const MALAYSIA_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: MALAYSIA_TIME_ZONE,
  calendar: "gregory",
  numberingSystem: "latn",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function invalidDateOnly(value: unknown): RangeError {
  return new RangeError(
    `Invalid date-only value ${JSON.stringify(value)}; expected canonical YYYY-MM-DD`,
  );
}

function isGregorianLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInGregorianMonth(year: number, month: number): number {
  const days = [31, isGregorianLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}

function parseCivilDate(value: unknown): CivilDate {
  if (typeof value !== "string") {
    throw invalidDateOnly(value);
  }

  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) {
    throw invalidDateOnly(value);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInGregorianMonth(year, month)) {
    throw invalidDateOnly(value);
  }

  return { year, month, day };
}

function compareCivilDates(left: CivilDate, right: CivilDate): number {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

function addOneCivilDay(date: CivilDate): CivilDate {
  if (date.day < daysInGregorianMonth(date.year, date.month)) {
    return { ...date, day: date.day + 1 };
  }
  if (date.month < 12) {
    return { year: date.year, month: date.month + 1, day: 1 };
  }
  return { year: date.year + 1, month: 1, day: 1 };
}

export function parseDateOnly(value: unknown): DateOnly {
  parseCivilDate(value);
  return value as DateOnly;
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

  if (compareCivilDates(parseCivilDate(start), parseCivilDate(end)) > 0) {
    throw new RangeError("startDate must be on or before endDate");
  }

  return { startDate: start, endDate: end };
}

export function currentMalaysiaDate(clock: Clock = systemClock): DateOnly {
  const now = clock.now();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError("Clock returned an invalid instant");
  }

  const parts = MALAYSIA_DATE_FORMATTER.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string | undefined =>
    parts.find((candidate) => candidate.type === type)?.value;
  const year = part("year");
  const month = part("month");
  const day = part("day");

  if (!year || !month || !day) {
    throw new RangeError("Could not determine the Malaysian calendar date");
  }

  return parseDateOnly(`${year.padStart(4, "0")}-${month}-${day}`);
}

function toUtcDateCarrier(date: CivilDate): Date {
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

  const start = parseCivilDate(normalized.startDate);
  const dayAfterEnd = addOneCivilDay(parseCivilDate(normalized.endDate));

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
