// Type definitions for the backend

export interface User {
  id: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionToken {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface ValidationResult {
  isValid: boolean;
  errors: { field: string; message: string }[];
}

export interface MigrationError {
  row: number;
  field?: string;
  message: string;
}

export interface FilterOptions {
  dateRange?: { start: Date; end: Date };
  categoryIds?: string[];
  limit?: number;
  offset?: number;
}

export interface AuthResponse {
  token: string;
  expiresAt: string;
}

export interface ApiError {
  error: string;
  details?: string[];
}

// Delivery Entry Types (Requirements 2.7, 5.1, 5.2, 6.1, 6.2, 6.3, 6.4, 9.1, 9.2)

export type RestaurantStatus = "halal" | "non-halal";

export interface DeliveryEntry {
  id: string;
  userId: string;
  restaurantName: string;
  restaurantStatus: RestaurantStatus;
  fareAmount: number;
  hasCashOrder: boolean;
  cashAmount?: number;
  entryDate: Date;
  timestamp: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DeliveryEntryFormData {
  restaurantName: string;
  restaurantStatus: RestaurantStatus;
  fareAmount: number;
  hasCashOrder: boolean;
  cashAmount?: number;
  entryDate?: Date;
}

// Validation Rules for Delivery Entries
export interface DeliveryEntryValidationRules {
  restaurantName: {
    required: true;
    maxLength: 100;
    minLength: 1;
  };
  fareAmount: {
    required: true;
    type: "numeric";
    min: 0.01;
    maxDecimals: 2;
  };
  cashAmount: {
    required: false;
    type: "numeric";
    min: 0.01;
    maxDecimals: 2;
  };
  restaurantStatus: {
    required: true;
    allowedValues: ["halal", "non-halal"];
  };
}

export const DELIVERY_ENTRY_VALIDATION_RULES: DeliveryEntryValidationRules = {
  restaurantName: {
    required: true,
    maxLength: 100,
    minLength: 1,
  },
  fareAmount: {
    required: true,
    type: "numeric",
    min: 0.01,
    maxDecimals: 2,
  },
  cashAmount: {
    required: false,
    type: "numeric",
    min: 0.01,
    maxDecimals: 2,
  },
  restaurantStatus: {
    required: true,
    allowedValues: ["halal", "non-halal"],
  },
};
