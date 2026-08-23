import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  RandomUuidGenerator,
  ReportDomainError,
  SystemClock,
  asReportDateString,
  formatUtcTimestamp,
  isReportDateString,
  isReportStatus,
  isReportType,
  isTerminalReportStatus,
  toPublicReportFailure,
  type ReportSnapshot,
} from "./index";

describe("report date and timestamp contracts", () => {
  it.each([
    "0001-01-01",
    "2000-02-29",
    "2025-12-31",
    "9999-12-31",
  ])("accepts strict existing Gregorian date %s", (value) => {
    expect(isReportDateString(value)).toBe(true);
    expect(asReportDateString(value)).toBe(value);
  });

  it.each([
    "0000-12-31",
    "2023-02-29",
    "2024-02-30",
    "2025-13-01",
    "2025-1-01",
    "2025-01-1",
    "2025-01-01T00:00:00Z",
    " 2025-01-01",
    null,
  ])("rejects malformed or nonexistent date %s", (value) => {
    expect(isReportDateString(value)).toBe(false);
    expect(asReportDateString(value)).toBeNull();
  });

  it("formats UTC instants at exact second precision", () => {
    expect(formatUtcTimestamp(new Date("2025-01-02T03:04:05.987Z"))).toBe(
      "2025-01-02T03:04:05Z",
    );
  });

  it("rejects invalid instants", () => {
    expect(() => formatUtcTimestamp(new Date(Number.NaN))).toThrow(RangeError);
  });
});
describe("report constants", () => {
  it("recognizes only canonical wire report types and statuses", () => {
    expect(isReportType("weekly")).toBe(true);
    expect(isReportType("WEEKLY")).toBe(false);
    expect(isReportStatus("email_accepted")).toBe(true);
    expect(isReportStatus("EMAIL_ACCEPTED")).toBe(false);
    expect(isTerminalReportStatus("sent")).toBe(true);
    expect(isTerminalReportStatus("failed")).toBe(true);
    expect(isTerminalReportStatus("processing")).toBe(false);
  });
});

describe("safe report domain errors", () => {
  it("projects only stable public fields", () => {
    const error = new ReportDomainError("invalid_reference_date", {
      fieldErrors: { referenceDate: "Use YYYY-MM-DD." },
      cause: new Error("database-password=secret"),
    });

    expect(error.toPublicFailure()).toEqual({
      code: "invalid_reference_date",
      message: "Reference date must be a valid date in YYYY-MM-DD format.",
      fieldErrors: { referenceDate: "Use YYYY-MM-DD." },
    });
    expect(Object.keys(error.toPublicFailure()).sort()).toEqual([
      "code",
      "fieldErrors",
      "message",
    ]);
  });

  it("uses the catalog message even if the internal Error is modified", () => {
    const error = new ReportDomainError("provider_rejected", {
      cause: new Error("provider-key=secret"),
    });
    error.message = "token=secret";

    expect(toPublicReportFailure(error)).toEqual({
      code: "provider_rejected",
      stage: "email_submission",
      message: "The email provider rejected the report email.",
    });
  });

  it("collapses arbitrary exceptions to a fixed secret-free failure", () => {
    const failure = toPublicReportFailure(
      new Error("Bearer secret-token at /internal/source.ts:42"),
    );

    expect(failure).toEqual({
      code: "unexpected_report_error",
      stage: "unexpected",
      message: "The report could not be completed because of an unexpected error.",
    });
    expect(JSON.stringify(failure)).not.toContain("secret-token");
    expect(JSON.stringify(failure)).not.toContain("source.ts");
  });
});
describe("report value and infrastructure contracts", () => {
  it("retains Prisma Decimal values throughout snapshot money fields", () => {
    const date = asReportDateString("2025-01-08");
    expect(date).not.toBeNull();
    if (date === null) {
      throw new Error("test fixture date must be valid");
    }

    const zero = new Prisma.Decimal("0.00");
    const fare = new Prisma.Decimal("10.25");
    const snapshot = {
      id: "snapshot-id",
      reportRequestId: "request-id",
      reportType: "weekly",
      period: { startDate: date, endDate: date, inclusive: true },
      createdAt: new Date("2025-01-08T00:00:00Z"),
      entries: [
        {
          sourceEntryId: "entry-id",
          restaurantName: "Restaurant",
          restaurantStatus: "halal",
          fareAmount: fare,
          hasCashOrder: false,
          cashAmount: null,
          entryDate: date,
          entryTimestamp: new Date("2025-01-08T00:00:00Z"),
        },
      ],
      summary: {
        recordCount: 1,
        digitalIncomeTotal: fare,
        cashIncomeTotal: zero,
        halalIncomeTotal: fare,
        nonHalalIncomeTotal: zero,
      },
    } satisfies ReportSnapshot;

    expect(snapshot.summary.digitalIncomeTotal).toBeInstanceOf(Prisma.Decimal);
    expect(snapshot.summary.digitalIncomeTotal.toFixed(2)).toBe("10.25");
  });

  it("provides injectable system clock and UUID generation defaults", () => {
    expect(new SystemClock().now()).toBeInstanceOf(Date);
    expect(new RandomUuidGenerator().generate()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
