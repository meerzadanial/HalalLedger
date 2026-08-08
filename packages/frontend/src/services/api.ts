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
  getAll: async (filters?: {
    startDate?: Date;
    endDate?: Date;
    restaurantStatus?: RestaurantStatus;
    paymentType?: 'cash' | 'digital' | 'both';
    limit?: number;
    offset?: number;
  }): Promise<{ entries: DeliveryEntry[]; total: number }> => {
    const params = new URLSearchParams();
    
    if (filters?.startDate) {
      params.append('startDate', filters.startDate.toISOString());
    }
    if (filters?.endDate) {
      params.append('endDate', filters.endDate.toISOString());
    }
    if (filters?.restaurantStatus) {
      params.append('restaurantStatus', filters.restaurantStatus);
    }
    if (filters?.paymentType) {
      params.append('paymentType', filters.paymentType);
    }
    if (filters?.limit) {
      params.append('limit', filters.limit.toString());
    }
    if (filters?.offset) {
      params.append('offset', filters.offset.toString());
    }

    const url = `${API_BASE_URL}/api/income-entries${params.toString() ? '?' + params.toString() : ''}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: getAuthHeaders(),
    });

    if (!response.ok) {
      await handleApiError(response);
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
  getTotals: async (filters?: {
    startDate?: Date;
    endDate?: Date;
    restaurantStatus?: RestaurantStatus;
  }): Promise<IncomeTotals> => {
    const params = new URLSearchParams();
    
    if (filters?.startDate) {
      params.append('startDate', filters.startDate.toISOString());
    }
    if (filters?.endDate) {
      params.append('endDate', filters.endDate.toISOString());
    }
    if (filters?.restaurantStatus) {
      params.append('restaurantStatus', filters.restaurantStatus);
    }

    const url = `${API_BASE_URL}/api/analytics/totals${params.toString() ? '?' + params.toString() : ''}`;
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

// Export all APIs as a single object
export default {
  auth: authApi,
  deliveryEntries: deliveryEntriesApi,
  analytics: analyticsApi,
  autocomplete: autocompleteApi,
};
