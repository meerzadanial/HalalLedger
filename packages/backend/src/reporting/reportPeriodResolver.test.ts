import { describe, expect, it } from "vitest";
import {
  ReportPeriodResolutionError,
  ReportPeriodResolver,
  type Clock,
  type ReportPeriodErrorReason,
} from "./index";

class FixedClock implements Clock {
  constructor(private readonly instant: string) {}

  now(): Date {
    return new Date(this.instant);
  }
}

function resolverAt(instant = "2025-01-15T12:00:00Z") {
  return new ReportPeriodResolver(new FixedClock(instant));
}

function expectResolutionError(
  action: () => unknown,
  reason: ReportPeriodErrorReason,
  code: string,
): void {
  try {
    action();
    throw new Error("Expected period resolution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ReportPeriodResolutionError);
    const resolutionError = error as ReportPeriodResolutionError;
    expect(resolutionError.reason).toBe(reason);
    expect(resolutionError.code).toBe(code);
    expect(resolutionError.fieldErrors).toBeDefined();
  }
}

describe("ReportPeriodResolver", () => {
  it("resolves a weekly reference to its inclusive Monday-Sunday period", () => {
    expect(resolverAt().resolve({
      reportType: "weekly",
      referenceDate: "2025-01-08",
      timeZone: "Asia/Kuala_Lumpur",
    })).toEqual({
      reportType: "weekly",
      referenceDate: "2025-01-08",
      period: {
        startDate: "2025-01-06",
        endDate: "2025-01-12",
        inclusive: true,
      },
    });
  });

  it("resolves leap-month and supported year-0001 boundaries", () => {
    const resolver = resolverAt();
    expect(resolver.resolve({
      reportType: "monthly",
      referenceDate: "2024-02-29",
      timeZone: "UTC",
    }).period).toEqual({
      startDate: "2024-02-01",
      endDate: "2024-02-29",
      inclusive: true,
    });
    expect(resolver.resolve({
      reportType: "weekly",
      referenceDate: "0001-01-01",
      timeZone: "UTC",
    }).period).toEqual({
      startDate: "0001-01-01",
      endDate: "0001-01-07",
      inclusive: true,
    });
  });

  it("uses the injected instant and account IANA timezone for the current date", () => {
    const resolver = resolverAt("2025-01-01T16:30:00Z");

    expect(() => resolver.resolve({
      reportType: "monthly",
      referenceDate: "2025-01-02",
      timeZone: "Asia/Kuala_Lumpur",
    })).not.toThrow();
    expectResolutionError(
      () => resolver.resolve({
        reportType: "monthly",
        referenceDate: "2025-01-02",
        timeZone: "America/New_York",
      }),
      "future_date",
      "future_reference_date",
    );
  });

  it.each([
    [undefined, "missing", "missing_reference_date"],
    ["", "missing", "missing_reference_date"],
    ["2025-1-02", "malformed", "invalid_reference_date"],
    ["10000-01-01", "malformed", "invalid_reference_date"],
    ["2025-02-29", "nonexistent", "invalid_reference_date"],
    ["2025-13-01", "nonexistent", "invalid_reference_date"],
    ["0000-12-31", "pre_range", "invalid_reference_date"],
    ["-000001-12-31", "pre_range", "invalid_reference_date"],
  ] as const)(
    "returns typed reference-date validation for %s",
    (referenceDate, reason, code) => {
      expectResolutionError(
        () => resolverAt().resolve({
          reportType: "weekly",
          referenceDate,
          timeZone: "UTC",
        }),
        reason,
        code,
      );
    },
  );

  it.each([undefined, null, "", "WEEKLY", "yearly"])(
    "returns a typed report-type error for %s",
    (reportType) => {
      expectResolutionError(
        () => resolverAt().resolve({
          reportType,
          referenceDate: "2025-01-01",
          timeZone: "UTC",
        }),
        "report_type",
        "invalid_report_type",
      );
    },
  );

  it("rejects the day after the timezone-local current date", () => {
    expectResolutionError(
      () => resolverAt("2025-01-15T23:59:59Z").resolve({
        reportType: "weekly",
        referenceDate: "2025-01-16",
        timeZone: "UTC",
      }),
      "future_date",
      "future_reference_date",
    );
  });
});
