import { describe, it, expect } from "vitest";
import {
  RestaurantStatus,
  DeliveryEntry,
  DeliveryEntryFormData,
  DELIVERY_ENTRY_VALIDATION_RULES,
} from "./index";

describe("DeliveryEntry Types", () => {
  describe("RestaurantStatus", () => {
    it("should accept 'halal' as valid status", () => {
      const status: RestaurantStatus = "halal";
      expect(status).toBe("halal");
    });

    it("should accept 'non-halal' as valid status", () => {
      const status: RestaurantStatus = "non-halal";
      expect(status).toBe("non-halal");
    });
  });

  describe("DeliveryEntry interface", () => {
    it("should create a valid delivery entry with all required fields", () => {
      const entry: DeliveryEntry = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        userId: "user-123",
        restaurantName: "Test Restaurant",
        restaurantStatus: "halal",
        fareAmount: 25.5,
        hasCashOrder: true,
        cashAmount: 5.0,
        entryDate: new Date("2024-01-15"),
        timestamp: new Date("2024-01-15T14:30:00Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(entry.restaurantName).toBe("Test Restaurant");
      expect(entry.restaurantStatus).toBe("halal");
      expect(entry.fareAmount).toBe(25.5);
      expect(entry.hasCashOrder).toBe(true);
      expect(entry.cashAmount).toBe(5.0);
    });

    it("should create a valid delivery entry without cash amount", () => {
      const entry: DeliveryEntry = {
        id: "123e4567-e89b-12d3-a456-426614174000",
        userId: "user-123",
        restaurantName: "Test Restaurant",
        restaurantStatus: "non-halal",
        fareAmount: 30.0,
        hasCashOrder: false,
        entryDate: new Date("2024-01-15"),
        timestamp: new Date("2024-01-15T14:30:00Z"),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      expect(entry.cashAmount).toBeUndefined();
      expect(entry.hasCashOrder).toBe(false);
    });
  });

  describe("DeliveryEntryFormData interface", () => {
    it("should create valid form data with all fields", () => {
      const formData: DeliveryEntryFormData = {
        restaurantName: "Pizza Palace",
        restaurantStatus: "halal",
        fareAmount: 32.5,
        hasCashOrder: true,
        cashAmount: 5.0,
        entryDate: new Date("2024-01-15"),
      };

      expect(formData.restaurantName).toBe("Pizza Palace");
      expect(formData.fareAmount).toBe(32.5);
      expect(formData.cashAmount).toBe(5.0);
    });

    it("should create valid form data without optional fields", () => {
      const formData: DeliveryEntryFormData = {
        restaurantName: "Pizza Palace",
        restaurantStatus: "halal",
        fareAmount: 32.5,
        hasCashOrder: false,
      };

      expect(formData.cashAmount).toBeUndefined();
      expect(formData.entryDate).toBeUndefined();
    });
  });

  describe("DELIVERY_ENTRY_VALIDATION_RULES", () => {
    it("should define restaurant name validation rules", () => {
      const rules = DELIVERY_ENTRY_VALIDATION_RULES.restaurantName;

      expect(rules.required).toBe(true);
      expect(rules.maxLength).toBe(100);
      expect(rules.minLength).toBe(1);
    });

    it("should define fare amount validation rules", () => {
      const rules = DELIVERY_ENTRY_VALIDATION_RULES.fareAmount;

      expect(rules.required).toBe(true);
      expect(rules.type).toBe("numeric");
      expect(rules.min).toBe(0.01);
      expect(rules.maxDecimals).toBe(2);
    });

    it("should define cash amount validation rules", () => {
      const rules = DELIVERY_ENTRY_VALIDATION_RULES.cashAmount;

      expect(rules.required).toBe(false);
      expect(rules.type).toBe("numeric");
      expect(rules.min).toBe(0.01);
      expect(rules.maxDecimals).toBe(2);
    });

    it("should define restaurant status validation rules", () => {
      const rules = DELIVERY_ENTRY_VALIDATION_RULES.restaurantStatus;

      expect(rules.required).toBe(true);
      expect(rules.allowedValues).toEqual(["halal", "non-halal"]);
      expect(rules.allowedValues).toHaveLength(2);
    });
  });
});

describe("Validation Rules - Restaurant Name", () => {
  const rules = DELIVERY_ENTRY_VALIDATION_RULES.restaurantName;

  it("should require non-empty restaurant name", () => {
    expect(rules.required).toBe(true);
    expect(rules.minLength).toBe(1);
  });

  it("should enforce max 100 characters for restaurant name", () => {
    expect(rules.maxLength).toBe(100);
  });
});

describe("Validation Rules - Amounts", () => {
  describe("Fare Amount", () => {
    const rules = DELIVERY_ENTRY_VALIDATION_RULES.fareAmount;

    it("should be numeric", () => {
      expect(rules.type).toBe("numeric");
    });

    it("should be greater than 0", () => {
      expect(rules.min).toBe(0.01);
    });

    it("should allow max 2 decimal places", () => {
      expect(rules.maxDecimals).toBe(2);
    });
  });

  describe("Cash Amount", () => {
    const rules = DELIVERY_ENTRY_VALIDATION_RULES.cashAmount;

    it("should be numeric", () => {
      expect(rules.type).toBe("numeric");
    });

    it("should be greater than 0", () => {
      expect(rules.min).toBe(0.01);
    });

    it("should allow max 2 decimal places", () => {
      expect(rules.maxDecimals).toBe(2);
    });

    it("should be optional", () => {
      expect(rules.required).toBe(false);
    });
  });
});

describe("Validation Rules - Restaurant Status", () => {
  const rules = DELIVERY_ENTRY_VALIDATION_RULES.restaurantStatus;

  it("should be required", () => {
    expect(rules.required).toBe(true);
  });

  it("should only allow 'halal' or 'non-halal'", () => {
    expect(rules.allowedValues).toContain("halal");
    expect(rules.allowedValues).toContain("non-halal");
    expect(rules.allowedValues).toHaveLength(2);
  });
});
