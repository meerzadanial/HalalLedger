/**
 * Form State Storage - Utilities for preserving form state in localStorage
 * 
 * Features:
 * - Save form state to localStorage on session expiry
 * - Restore form state after successful re-authentication
 * - Clear form state after successful submission
 * 
 * Validates Requirements: 1.3
 */

const FORM_STATE_KEY = 'halalornot_form_state';

export interface FormState {
  formType: 'delivery-entry' | 'other';
  data: Record<string, any>;
  timestamp: number;
  step?: number;
}

/**
 * Saves form state to localStorage
 * @param formType - Type of form being saved
 * @param data - Form data object
 * @param step - Current step (for multi-step forms)
 */
export function saveFormState(
  formType: FormState['formType'],
  data: Record<string, any>,
  step?: number
): void {
  try {
    const formState: FormState = {
      formType,
      data,
      timestamp: Date.now(),
      step,
    };
    localStorage.setItem(FORM_STATE_KEY, JSON.stringify(formState));
  } catch (error) {
    console.error('Failed to save form state:', error);
    // Fail silently - form state preservation is a nice-to-have
  }
}

/**
 * Retrieves saved form state from localStorage
 * @param maxAgeMs - Maximum age of form state in milliseconds (default: 1 hour)
 * @returns FormState if found and valid, null otherwise
 */
export function getFormState(maxAgeMs: number = 60 * 60 * 1000): FormState | null {
  try {
    const stored = localStorage.getItem(FORM_STATE_KEY);
    if (!stored) {
      return null;
    }

    const formState: FormState = JSON.parse(stored);

    // Check if form state is too old
    const age = Date.now() - formState.timestamp;
    if (age > maxAgeMs) {
      clearFormState();
      return null;
    }

    return formState;
  } catch (error) {
    console.error('Failed to retrieve form state:', error);
    clearFormState(); // Clear corrupted data
    return null;
  }
}

/**
 * Clears saved form state from localStorage
 */
export function clearFormState(): void {
  try {
    localStorage.removeItem(FORM_STATE_KEY);
  } catch (error) {
    console.error('Failed to clear form state:', error);
  }
}

/**
 * Checks if there is a saved form state
 * @returns boolean indicating if form state exists
 */
export function hasFormState(): boolean {
  try {
    return localStorage.getItem(FORM_STATE_KEY) !== null;
  } catch (error) {
    return false;
  }
}
