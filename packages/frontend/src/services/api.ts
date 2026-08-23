/**
 * API Service - Handles all backend communication
 * 
 * Features:
 * - Authentication endpoints
 * - Delivery entry CRUD operations
 * - Analytics and totals
 * - Autocomplete suggestions
 * 
 * Validates Requirements: 10.1, 10.2, 10.3
 */

import type {
  AuthResponse,
  DeliveryEntry,
  DeliveryEntryFormData,
  IncomeTotals,
  RestaurantStatus,
} from '../types';

// API base URL - will be configured via environment variable
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000';

// Helper function to get auth token from localStorage
const getAuthToken = (): string | null => {
  return localStorage.getItem('authToken');
};

// Helper function to build headers with auth token
const getAuthHeaders = (): HeadersInit => {
  const token = getAuthToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

// Helper function to handle API errors
const handleApiError = async (response: Response): Promise<never> => {
  let errorMessage = 'An error occurred';
  
  try {
    const errorData = await response.json();
    errorMessage = errorData.error || errorData.message || errorMessage;
  } catch {
    errorMessage = response.statusText || errorMessage;
  }

  throw new Error(errorMessage);
};

export type DateOnlyString = string;
export type DashboardPaymentType = 'cash' | 'digital' | 'both';

export interface DashboardFilterQuery {
  readonly startDate?: DateOnlyString;
  readonly endDate?: DateOnlyString;
  readonly restaurantStatus?: RestaurantStatus;
  readonly paymentType?: DashboardPaymentType;
}

export interface DashboardPaginationQuery {
  readonly limit?: number;
  readonly offset?: number;
}

export type DeliveryEntriesQuery = DashboardFilterQuery & DashboardPaginationQuery;
export type DashboardRequestOptions = Readonly<{ signal?: AbortSignal }>;
export type DeliveryEntryPage = { entries: DeliveryEntry[]; total: number };

const SAFE_DASHBOARD_VALIDATION_DETAILS = new Set([
  'Start date must be a canonical date in YYYY-MM-DD format',
  'End date must be a canonical date in YYYY-MM-DD format',
  'startDate must be on or before endDate',
  'Invalid date range',
  'Restaurant status must be either "halal" or "non-halal"',
  'Payment type must be "cash", "digital", or "both"',
  'Limit must be an integer between 1 and 100',
  'Offset must be an integer between 0 and 2147483647',
]);

const isDashboardErrorBody = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class DashboardApiError extends Error {
  readonly status: number;
  readonly details: readonly string[];

  constructor(status: number, message: string, details: readonly string[] = []) {
    super(message);
    this.name = 'DashboardApiError';
    this.status = status;
    this.details = details;
  }
}

const handleDashboardApiError = async (response: Response): Promise<never> => {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DashboardApiError(
      response.status,
      response.statusText || 'An error occurred',
    );
  }

  if (!isDashboardErrorBody(body)) {
    throw new DashboardApiError(response.status, 'An error occurred');
  }

  if (response.status === 400 && body.error === 'Validation failed') {
    const validationDetails = Array.isArray(body.details)
      ? [...new Set(body.details.filter(
        (detail): detail is string =>
          typeof detail === 'string' && SAFE_DASHBOARD_VALIDATION_DETAILS.has(detail),
      ))]
      : [];
    const message = validationDetails.length > 0
      ? `Validation failed: ${validationDetails.join(' ')}`
      : 'Validation failed';
    throw new DashboardApiError(response.status, message, validationDetails);
  }

  const message = typeof body.error === 'string'
    ? body.error
    : typeof body.message === 'string'
      ? body.message
      : 'An error occurred';
  throw new DashboardApiError(response.status, message);
};

// Helper function to retry failed requests (for transient failures)
// Exported for reuse in consumers that need retry-aware fetches.
export const fetchWithRetry = async (
  url: string,
  options: RequestInit,
  maxRetries = 2,
  retryDelay = 1000
): Promise<Response> => {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      
      // Don't retry on 4xx errors (client errors) - these won't succeed on retry
      if (response.status >= 400 && response.status < 500 && response.status !== 408) {
        return response;
      }

      // Retry on 5xx errors (server errors) or 408 (timeout)
      if (response.ok || attempt === maxRetries) {
        return response;
      }

      // Server error - wait before retry
      await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
    } catch (error) {
      lastError = error as Error;
      
      // Network error - wait before retry
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, retryDelay * Math.pow(2, attempt)));
      }
    }
  }

  // All retries failed
  throw lastError || new Error('Request failed after retries');
};

// ============================================
// Authentication API
// ============================================

export const authApi = {
  /**
   * Login with email and password
   * @param email - User email
   * @param password - User password
   * @returns Promise with auth token and expiration
   */
  login: async (email: string, password: string): Promise<AuthResponse> => {
    const response = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    const data = await response.json();
    
    // Store token in localStorage
    if (data.token) {
      localStorage.setItem('authToken', data.token);
    }

    return data;
  },

  /**
   * Logout current user
   */
  logout: async (): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/api/auth/logout`, {
      method: 'POST',
      headers: getAuthHeaders(),
    });

    // Clear token regardless of response
    localStorage.removeItem('authToken');

    if (!response.ok) {
      await handleApiError(response);
    }
  },

  /**
   * Get current session information
   */
  getSession: async (): Promise<{ userId: string; email: string; expiresAt: string }> => {
    const response = await fetch(`${API_BASE_URL}/api/auth/session`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },

  /**
   * Register a new user
   * @param email - User email
   * @param password - User password
   */
  register: async (email: string, password: string): Promise<{ id: string; email: string }> => {
    const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },
};

// ============================================
// Delivery Entries API
// ============================================

export const deliveryEntriesApi = {
  /**
   * Create a new delivery entry
   * @param data - Delivery entry form data
   * @returns Promise with created delivery entry
   */
  create: async (data: DeliveryEntryFormData): Promise<DeliveryEntry> => {
    const response = await fetch(`${API_BASE_URL}/api/income-entries`, {
      method: 'POST',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },

  /**
   * Get delivery entries with optional filtering
   * @param filters - Optional filters
   * @returns Promise with entries and total count
   */
  getAll: async (
    filters?: DeliveryEntriesQuery,
    options?: DashboardRequestOptions,
  ): Promise<DeliveryEntryPage> => {
    const params = new URLSearchParams();
    
    if (filters?.startDate !== undefined) {
      params.append('startDate', filters.startDate);
    }
    if (filters?.endDate !== undefined) {
      params.append('endDate', filters.endDate);
    }
    if (filters?.restaurantStatus !== undefined) {
      params.append('restaurantStatus', filters.restaurantStatus);
    }
    if (filters?.paymentType !== undefined) {
      params.append('paymentType', filters.paymentType);
    }
    if (filters?.limit !== undefined) {
      params.append('limit', filters.limit.toString());
    }
    if (filters?.offset !== undefined) {
      params.append('offset', filters.offset.toString());
    }

    const url = `${API_BASE_URL}/api/income-entries${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: options?.signal,
    });

    if (!response.ok) {
      await handleDashboardApiError(response);
    }

    return await response.json();
  },

  /**
   * Get a single delivery entry by ID
   * @param id - Entry ID
   * @returns Promise with delivery entry
   */
  getById: async (id: string): Promise<DeliveryEntry> => {
    const response = await fetch(`${API_BASE_URL}/api/income-entries/${id}`, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },

  /**
   * Update an existing delivery entry
   * @param id - Entry ID
   * @param data - Partial delivery entry data
   * @returns Promise with updated delivery entry
   */
  update: async (id: string, data: Partial<DeliveryEntryFormData>): Promise<DeliveryEntry> => {
    const response = await fetch(`${API_BASE_URL}/api/income-entries/${id}`, {
      method: 'PUT',
      headers: getAuthHeaders(),
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },

  /**
   * Delete a delivery entry
   * @param id - Entry ID
   */
  delete: async (id: string): Promise<void> => {
    const response = await fetch(`${API_BASE_URL}/api/income-entries/${id}`, {
      method: 'DELETE',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      await handleApiError(response);
    }
  },
};

// ============================================
// Analytics API
// ============================================

export const analyticsApi = {
  /**
   * Get income totals with optional filtering
   * @param filters - Optional filters
   * @returns Promise with income totals breakdown
   */
  getTotals: async (
    filters?: DashboardFilterQuery,
    options?: DashboardRequestOptions,
  ): Promise<IncomeTotals> => {
    const params = new URLSearchParams();
    
    if (filters?.startDate !== undefined) {
      params.append('startDate', filters.startDate);
    }
    if (filters?.endDate !== undefined) {
      params.append('endDate', filters.endDate);
    }
    if (filters?.restaurantStatus !== undefined) {
      params.append('restaurantStatus', filters.restaurantStatus);
    }
    if (filters?.paymentType !== undefined) {
      params.append('paymentType', filters.paymentType);
    }

    const url = `${API_BASE_URL}/api/analytics/totals${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: getAuthHeaders(),
      signal: options?.signal,
    });

    if (!response.ok) {
      await handleDashboardApiError(response);
    }

    return await response.json();
  },
};

// ============================================
// Autocomplete API
// ============================================

export const autocompleteApi = {
  /**
   * Get restaurant name suggestions
   * @param searchQuery - Search query
   * @returns Promise with array of restaurant names
   */
  getRestaurantSuggestions: async (searchQuery: string): Promise<string[]> => {
    const params = new URLSearchParams({ q: searchQuery });
    const url = `${API_BASE_URL}/api/income-entries/autocomplete/restaurants?${params.toString()}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      await handleApiError(response);
    }

    return await response.json();
  },
};

// ============================================
// Bulk report API
// ============================================

export type ReportDateString = string;
export type ReportUtcTimestampString = string;
export type ReportType = 'weekly' | 'monthly';
export type ReportStatus =
  | 'pending'
  | 'processing'
  | 'email_submitted'
  | 'email_accepted'
  | 'sent'
  | 'failed';
export type ReportProgressStage =
  | 'data_retrieval'
  | 'snapshot'
  | 'csv_generation'
  | 'email_submission'
  | 'delivery_wait';
export type ReportFailureStage =
  | 'data_retrieval'
  | 'snapshot'
  | 'csv_generation'
  | 'report_size'
  | 'email_submission'
  | 'unexpected';
export type ReportFieldName =
  | 'reportType'
  | 'referenceDate'
  | 'clientRequestId'
  | 'reportRequestId';
export type ReportFieldErrors = Readonly<Partial<Record<ReportFieldName, string>>>;

export interface ReportPeriodDto {
  readonly startDate: ReportDateString;
  readonly endDate: ReportDateString;
  readonly inclusive: true;
}

export interface ResolveReportPeriodDto {
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriodDto;
  readonly accountEmail: string;
  readonly timeZone: string;
}

export interface PublicReportFailureDto {
  readonly code: string;
  readonly stage?: ReportFailureStage;
  readonly message: string;
  readonly fieldErrors?: ReportFieldErrors;
}

export interface ReportRequestDto {
  readonly id: string;
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
  readonly period: ReportPeriodDto;
  readonly accountEmail: string;
  readonly status: ReportStatus;
  readonly progressStage: ReportProgressStage;
  readonly createdAt: ReportUtcTimestampString;
  readonly providerAcceptedAt: ReportUtcTimestampString | null;
  readonly sentAt: ReportUtcTimestampString | null;
  readonly failure: PublicReportFailureDto | null;
  readonly canRetry: boolean;
}

export interface CreateReportRequestInput {
  readonly reportType: ReportType;
  readonly referenceDate: ReportDateString;
}

interface ReportErrorBody {
  readonly code?: unknown;
  readonly stage?: unknown;
  readonly message?: unknown;
  readonly fieldErrors?: unknown;
  readonly activeRequest?: unknown;
  readonly correlationId?: unknown;
}

export class ReportApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly stage?: ReportFailureStage;
  readonly fieldErrors?: ReportFieldErrors;
  readonly activeRequest?: ReportRequestDto;
  readonly correlationId?: string;

  constructor(options: {
    status: number;
    code: string;
    message: string;
    stage?: ReportFailureStage;
    fieldErrors?: ReportFieldErrors;
    activeRequest?: ReportRequestDto;
    correlationId?: string;
  }) {
    super(options.message);
    this.name = 'ReportApiError';
    this.status = options.status;
    this.code = options.code;
    this.stage = options.stage;
    this.fieldErrors = options.fieldErrors;
    this.activeRequest = options.activeRequest;
    this.correlationId = options.correlationId;
  }
}

const REPORT_FAILURE_STAGES: readonly ReportFailureStage[] = [
  'data_retrieval',
  'snapshot',
  'csv_generation',
  'report_size',
  'email_submission',
  'unexpected',
];
const REPORT_FIELD_NAMES: readonly ReportFieldName[] = [
  'reportType',
  'referenceDate',
  'clientRequestId',
  'reportRequestId',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toFailureStage = (value: unknown): ReportFailureStage | undefined =>
  typeof value === 'string' && REPORT_FAILURE_STAGES.includes(value as ReportFailureStage)
    ? value as ReportFailureStage
    : undefined;

const toFieldErrors = (value: unknown): ReportFieldErrors | undefined => {
  if (!isRecord(value)) return undefined;

  const fieldErrors: Partial<Record<ReportFieldName, string>> = {};
  for (const fieldName of REPORT_FIELD_NAMES) {
    const message = value[fieldName];
    if (typeof message === 'string') fieldErrors[fieldName] = message;
  }
  return Object.keys(fieldErrors).length > 0 ? fieldErrors : undefined;
};

const toReportApiError = async (response: Response): Promise<ReportApiError> => {
  let body: ReportErrorBody = {};
  try {
    const parsed: unknown = await response.json();
    if (isRecord(parsed)) body = parsed;
  } catch {
    // Non-JSON failures use fixed client-safe fallbacks below.
  }

  return new ReportApiError({
    status: response.status,
    code: typeof body.code === 'string' ? body.code : 'report_api_error',
    message: typeof body.message === 'string'
      ? body.message
      : 'The report request could not be completed.',
    stage: toFailureStage(body.stage),
    fieldErrors: toFieldErrors(body.fieldErrors),
    activeRequest: isRecord(body.activeRequest)
      ? body.activeRequest as unknown as ReportRequestDto
      : undefined,
    correlationId: typeof body.correlationId === 'string' ? body.correlationId : undefined,
  });
};

const reportFetch = async (
  path: string,
  options: RequestInit,
  retrySafe: boolean,
): Promise<Response> => {
  const url = `${API_BASE_URL}${path}`;
  const response = retrySafe
    ? await fetchWithRetry(url, options)
    : await fetch(url, options);
  if (!response.ok) throw await toReportApiError(response);
  return response;
};

/** Creates the idempotency key once per user POST action. */
export const createReportClientRequestId = (): string => crypto.randomUUID();

export const reportsApi = {
  resolve: async (
    reportType: ReportType,
    referenceDate: ReportDateString,
  ): Promise<ResolveReportPeriodDto> => {
    const params = new URLSearchParams({ reportType, referenceDate });
    const response = await reportFetch(
      `/api/report-periods/resolve?${params.toString()}`,
      { method: 'GET', headers: getAuthHeaders() },
      true,
    );
    return await response.json() as ResolveReportPeriodDto;
  },

  create: async (input: CreateReportRequestInput): Promise<ReportRequestDto> => {
    const clientRequestId = createReportClientRequestId();
    const response = await reportFetch(
      '/api/report-requests',
      {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({
          reportType: input.reportType,
          referenceDate: input.referenceDate,
          clientRequestId,
        }),
      },
      false,
    );
    return await response.json() as ReportRequestDto;
  },

  active: async (): Promise<ReportRequestDto | null> => {
    const response = await reportFetch(
      '/api/report-requests/active',
      { method: 'GET', headers: getAuthHeaders() },
      true,
    );
    return response.status === 204 ? null : await response.json() as ReportRequestDto;
  },

  status: async (reportRequestId: string): Promise<ReportRequestDto> => {
    const response = await reportFetch(
      `/api/report-requests/${encodeURIComponent(reportRequestId)}`,
      { method: 'GET', headers: getAuthHeaders() },
      true,
    );
    return await response.json() as ReportRequestDto;
  },

  retry: async (reportRequestId: string): Promise<ReportRequestDto> => {
    const clientRequestId = createReportClientRequestId();
    const response = await reportFetch(
      `/api/report-requests/${encodeURIComponent(reportRequestId)}/retries`,
      {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ clientRequestId }),
      },
      false,
    );
    return await response.json() as ReportRequestDto;
  },
};

// Export all APIs as a single object
export default {
  auth: authApi,
  deliveryEntries: deliveryEntriesApi,
  analytics: analyticsApi,
  autocomplete: autocompleteApi,
  reports: reportsApi,
};
