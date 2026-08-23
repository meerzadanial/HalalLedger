import { describe, expect, it } from "vitest";
import {
  buildOwnedEntryWhere,
  currentMalaysiaDate,
  normalizeExplicitDateRange,
  parseDateOnly,
  toPrismaDateRange,
} from "./incomeQuery";

describe("incomeQuery civil-date utilities", () => {
  it("accepts canonical Gregorian dates and rejects impossible or noncanonical values", () => {
    expect(parseDateOnly("2000-02-29")).toBe("2000-02-29");
    expect(parseDateOnly("2024-02-29")).toBe("2024-02-29");
    expect(parseDateOnly("0001-01-01")).toBe("0001-01-01");

    for (const value of [
      "0000-01-01",
      "1900-02-29",
      "2023-02-29",
      "2024-02-30",
      "2024-13-01",
      "2024-2-01",
      "2024-01-01T00:00:00Z",
    ]) {
      expect(() => parseDateOnly(value)).toThrow(RangeError);
    }
  });

  it("normalizes one-sided ranges and rejects reversed ranges", () => {
    expect(normalizeExplicitDateRange("2024-06-15", undefined)).toEqual({
      startDate: "2024-06-15",
      endDate: "2024-06-15",
    });
    expect(normalizeExplicitDateRange(undefined, "2024-06-15")).toEqual({
      startDate: "2024-06-15",
      endDate: "2024-06-15",
    });
    expect(() =>
      normalizeExplicitDateRange("2024-06-16", "2024-06-15"),
    ).toThrow("startDate must be on or before endDate");
  });

  it("calculates the Malaysian date at the UTC midnight boundary", () => {
    expect(
      currentMalaysiaDate({
        now: () => new Date("2024-01-01T15:59:59.999Z"),
      }),
    ).toBe("2024-01-01");
    expect(
      currentMalaysiaDate({
        now: () => new Date("2024-01-01T16:00:00.000Z"),
      }),
    ).toBe("2024-01-02");
    expect(
      currentMalaysiaDate({
        now: () => new Date("2023-12-31T16:00:00.000Z"),
      }),
    ).toBe("2024-01-01");
  });

  it("creates host-independent half-open ranges across leap and year boundaries", () => {
    const originalTimeZone = process.env.TZ;

    try {
      for (const timeZone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
        process.env.TZ = timeZone;

        const leapRange = toPrismaDateRange({
          startDate: "2024-02-29",
          endDate: "2024-02-29",
        });
        expect((leapRange.gte as Date).toISOString()).toBe(
          "2024-02-29T00:00:00.000Z",
        );
        expect((leapRange.lt as Date).toISOString()).toBe(
          "2024-03-01T00:00:00.000Z",
        );

        const yearRange = toPrismaDateRange({
          startDate: "2024-12-31",
          endDate: "2024-12-31",
        });
        expect((yearRange.gte as Date).toISOString()).toBe(
          "2024-12-31T00:00:00.000Z",
        );
        expect((yearRange.lt as Date).toISOString()).toBe(
          "2025-01-01T00:00:00.000Z",
        );
      }
    } finally {
      if (originalTimeZone === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTimeZone;
      }
    }
  });

  it("always scopes by owner and treats both payment types as unrestricted", () => {
    expect(
      buildOwnedEntryWhere("user-1", {
        restaurantStatus: "halal",
        paymentType: "both",
      }),
    ).toEqual({ userId: "user-1", restaurantStatus: "halal" });
    expect(buildOwnedEntryWhere("user-1", { paymentType: "cash" })).toEqual({
      userId: "user-1",
      hasCashOrder: true,
    });
    expect(
      buildOwnedEntryWhere("user-1", { paymentType: "digital" }),
    ).toEqual({ userId: "user-1", hasCashOrder: false });
  });
});
