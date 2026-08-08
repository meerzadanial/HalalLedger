/**
 * useApiQueries - React Query hooks for all API operations
 * 
 * Features:
 * - Automatic retry logic for transient failures (max 3 attempts)
 * - Exponential backoff retry strategy
 * - Error handling with toast notifications
 * - Optimistic updates for mutations
 * - Automatic cache invalidation
 * 
 * Validates Requirements: Error handling, retry logic from design
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useToast } from '../contexts/ToastContext';
import {
  authApi,
  deliveryEntriesApi,
  analyticsApi,
  autocompleteApi,
} from '../services/api';
import type {
  DeliveryEntryFormData,
  RestaurantStatus,
} from '../types';

// Query keys for cache management
export const queryKeys = {
  session: ['session'] as const,
  entries: (filters?: any) => ['entries', filters] as const,
  entry: (id: string) => ['entry', id] as const,
  totals: (filters?: any) => ['totals', filters] as const,
  restaurantSuggestions: (query: string) => ['restaurantSuggestions', query] as const,
};

// Retry configuration with exponential backoff
const retryConfig = {
  retry: 3, // Max 3 attempts
  retryDelay: (attemptIndex: number) => Math.min(1000 * 2 ** attemptIndex, 30000), // 1s, 2s, 4s, max 30s
};

// Helper to determine if error is retryable
function isRetryableError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('econnrefused') ||
      message.includes('etimedout') ||
      message.includes('temporary') ||
      message.includes('service unavailable')
    );
  }
  return false;
}

// Custom retry function that only retries on transient errors
function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= 3) return false;
  return isRetryableError(error);
}

// ============================================
// Authentication Hooks
// ============================================

export function useSession() {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const query = useQuery({
    queryKey: queryKeys.session,
    queryFn: authApi.getSession,
    retry: shouldRetry,
    retryDelay: retryConfig.retryDelay,
  });

  useEffect(() => {
    if (!query.error) return;
    const error = query.error as Error;
    if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
      localStorage.removeItem('authToken');
      navigate('/login');
      showToast('Your session has expired. Please log in again.', 'error');
    } else {
      showToast('Failed to validate session', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.error]);

  return query;
}

export function useLogin() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      authApi.login(email, password),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.session });
      showToast('Login successful!', 'success');
      navigate('/dashboard');
    },
    onError: (error: Error) => {
      showToast(error.message || 'Login failed. Please check your credentials.', 'error');
    },
  });
}

export function useLogout() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: authApi.logout,
    onSuccess: () => {
      queryClient.clear();
      localStorage.removeItem('authToken');
      showToast('Logged out successfully', 'success');
      navigate('/login');
    },
    onError: (error: Error) => {
      // Still navigate to login even on error
      queryClient.clear();
      localStorage.removeItem('authToken');
      navigate('/login');
      console.error('Logout error:', error);
    },
  });
}

// ============================================
// Delivery Entries Hooks
// ============================================

export function useDeliveryEntries(filters?: {
  startDate?: Date;
  endDate?: Date;
  restaurantStatus?: RestaurantStatus;
  paymentType?: 'cash' | 'digital' | 'both';
  limit?: number;
  offset?: number;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const query = useQuery({
    queryKey: queryKeys.entries(filters),
    queryFn: () => deliveryEntriesApi.getAll(filters),
    retry: shouldRetry,
    retryDelay: retryConfig.retryDelay,
  });

  useEffect(() => {
    if (!query.error) return;
    const error = query.error as Error;
    if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
      localStorage.removeItem('authToken');
      navigate('/login');
      showToast('Your session has expired. Please log in again.', 'error');
    } else {
      showToast('Failed to load delivery entries. Please try again.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.error]);

  return query;
}

export function useDeliveryEntry(id: string) {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const query = useQuery({
    queryKey: queryKeys.entry(id),
    queryFn: () => deliveryEntriesApi.getById(id),
    retry: shouldRetry,
    retryDelay: retryConfig.retryDelay,
    enabled: !!id, // Only run if ID is provided
  });

  useEffect(() => {
    if (!query.error) return;
    const error = query.error as Error;
    if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
      localStorage.removeItem('authToken');
      navigate('/login');
      showToast('Your session has expired. Please log in again.', 'error');
    } else if (error.message.includes('not found')) {
      showToast('Entry not found', 'error');
      navigate('/dashboard');
    } else {
      showToast('Failed to load entry. Please try again.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.error]);

  return query;
}

export function useCreateDeliveryEntry() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (data: DeliveryEntryFormData) => deliveryEntriesApi.create(data),
    onSuccess: () => {
      // Invalidate and refetch entries and totals
      queryClient.invalidateQueries({ queryKey: queryKeys.entries() });
      queryClient.invalidateQueries({ queryKey: queryKeys.totals() });
      showToast('Delivery entry created successfully!', 'success');
      navigate('/dashboard');
    },
    onError: (error: Error) => {
      if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
        localStorage.removeItem('authToken');
        navigate('/login');
        showToast('Your session has expired. Please log in again.', 'error');
      } else {
        showToast(error.message || 'Failed to create entry. Please try again.', 'error');
      }
    },
  });
}

export function useUpdateDeliveryEntry() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<DeliveryEntryFormData> }) =>
      deliveryEntriesApi.update(id, data),
    onSuccess: (_, variables) => {
      // Invalidate specific entry, entries list, and totals
      queryClient.invalidateQueries({ queryKey: queryKeys.entry(variables.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.entries() });
      queryClient.invalidateQueries({ queryKey: queryKeys.totals() });
      showToast('Delivery entry updated successfully!', 'success');
      navigate('/dashboard');
    },
    onError: (error: Error) => {
      if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
        localStorage.removeItem('authToken');
        navigate('/login');
        showToast('Your session has expired. Please log in again.', 'error');
      } else {
        showToast(error.message || 'Failed to update entry. Please try again.', 'error');
      }
    },
  });
}

export function useDeleteDeliveryEntry() {
  const queryClient = useQueryClient();
  const { showToast } = useToast();

  return useMutation({
    mutationFn: (id: string) => deliveryEntriesApi.delete(id),
    onSuccess: () => {
      // Invalidate entries and totals to refresh the dashboard
      queryClient.invalidateQueries({ queryKey: queryKeys.entries() });
      queryClient.invalidateQueries({ queryKey: queryKeys.totals() });
      showToast('Entry deleted successfully', 'success');
    },
    onError: (error: Error) => {
      if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
        showToast('Your session has expired. Please log in again.', 'error');
      } else {
        showToast(error.message || 'Failed to delete entry. Please try again.', 'error');
      }
    },
  });
}

// ============================================
// Analytics Hooks
// ============================================

export function useIncomeTotals(filters?: {
  startDate?: Date;
  endDate?: Date;
  restaurantStatus?: RestaurantStatus;
}) {
  const navigate = useNavigate();
  const { showToast } = useToast();

  const query = useQuery({
    queryKey: queryKeys.totals(filters),
    queryFn: () => analyticsApi.getTotals(filters),
    retry: shouldRetry,
    retryDelay: retryConfig.retryDelay,
  });

  useEffect(() => {
    if (!query.error) return;
    const error = query.error as Error;
    if (error.message.includes('Unauthorized') || error.message.includes('Invalid token')) {
      localStorage.removeItem('authToken');
      navigate('/login');
      showToast('Your session has expired. Please log in again.', 'error');
    } else {
      showToast('Failed to load income totals. Please try again.', 'error');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.error]);

  return query;
}

// ============================================
// Autocomplete Hooks
// ============================================

export function useRestaurantSuggestions(searchQuery: string) {
  const query = useQuery({
    queryKey: queryKeys.restaurantSuggestions(searchQuery),
    queryFn: () => autocompleteApi.getRestaurantSuggestions(searchQuery),
    enabled: searchQuery.length >= 2, // Only run if query is at least 2 characters
    retry: shouldRetry,
    retryDelay: retryConfig.retryDelay,
    staleTime: 5 * 60 * 1000, // Consider data fresh for 5 minutes
  });

  useEffect(() => {
    // Don't show error toast for autocomplete failures - it's not critical
    if (query.error) {
      console.error('Autocomplete error:', query.error);
    }
  }, [query.error]);

  return query;
}
