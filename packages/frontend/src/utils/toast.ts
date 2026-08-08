/**
 * Toast Notification Utility
 * 
 * Provides consistent toast notifications across the application
 * using react-hot-toast library.
 * 
 * Features:
 * - Success messages for completed operations
 * - Error messages for failures
 * - Loading states for async operations
 * - Consistent styling and positioning
 * 
 * Usage:
 * ```typescript
 * import { showSuccess, showError, showLoading } from './utils/toast';
 * 
 * showSuccess('Entry created successfully!');
 * showError('Failed to save entry');
 * const toastId = showLoading('Creating entry...');
 * ```
 */

import toast from 'react-hot-toast';

/**
 * Show success toast notification
 * @param message - Success message to display
 * @returns Toast ID
 */
export const showSuccess = (message: string): string => {
  return toast.success(message, {
    duration: 3000,
    position: 'top-right',
    style: {
      background: '#10B981',
      color: '#fff',
    },
  });
};

/**
 * Show error toast notification
 * @param message - Error message to display
 * @returns Toast ID
 */
export const showError = (message: string): string => {
  return toast.error(message, {
    duration: 4000,
    position: 'top-right',
    style: {
      background: '#EF4444',
      color: '#fff',
    },
  });
};

/**
 * Show loading toast notification
 * @param message - Loading message to display
 * @returns Toast ID (can be used to dismiss later)
 */
export const showLoading = (message: string): string => {
  return toast.loading(message, {
    position: 'top-right',
  });
};

/**
 * Dismiss a specific toast
 * @param toastId - ID of toast to dismiss
 */
export const dismissToast = (toastId: string): void => {
  toast.dismiss(toastId);
};

/**
 * Dismiss all toasts
 */
export const dismissAllToasts = (): void => {
  toast.dismiss();
};

/**
 * Show promise-based toast (automatic success/error handling)
 * @param promise - Promise to track
 * @param messages - Messages for loading, success, and error states
 * @returns Promise result
 */
export const showPromiseToast = async <T,>(
  promise: Promise<T>,
  messages: {
    loading: string;
    success: string;
    error: string;
  }
): Promise<T> => {
  return toast.promise(
    promise,
    {
      loading: messages.loading,
      success: messages.success,
      error: messages.error,
    },
    {
      position: 'top-right',
    }
  );
};

export default {
  success: showSuccess,
  error: showError,
  loading: showLoading,
  dismiss: dismissToast,
  dismissAll: dismissAllToasts,
  promise: showPromiseToast,
};
