import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import EntryWorkflow from './EntryWorkflow';
import * as api from '../services/api';

// Mock the API modules
vi.mock('../services/api', () => ({
  deliveryEntriesApi: {
    create: vi.fn(),
  },
  autocompleteApi: {
    getRestaurantSuggestions: vi.fn(),
  },
}));

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

// Helper to render component with router
function renderWithRouter(component: React.ReactElement) {
  return render(<BrowserRouter>{component}</BrowserRouter>);
}

describe('EntryWorkflow - Date Assignment (Task 13.1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.autocompleteApi.getRestaurantSuggestions).mockResolvedValue([]);
  });

  describe('Requirement 12.1: Default entry date to current date', () => {
    it('should initialize with current date by default', () => {
      renderWithRouter(<EntryWorkflow />);
      
      // Step 1 should be the date step
      expect(screen.getByText('Entry Date')).toBeInTheDocument();
      
      // Date input should exist
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      expect(dateInput).toBeInTheDocument();
      
      // Should have today's date as value
      const today = new Date();
      const expectedValue = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      expect(dateInput.value).toBe(expectedValue);
    });
  });

  describe('Requirement 12.2: Allow manual date input for past dates', () => {
    it('should allow user to select a past date', async () => {
      renderWithRouter(<EntryWorkflow />);
      
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      expect(dateInput).toBeInTheDocument();
      
      // Set a past date
      const pastDate = '2024-01-15';
      fireEvent.change(dateInput, { target: { value: pastDate } });
      
      // Date should be updated
      await waitFor(() => {
        expect(dateInput.value).toBe(pastDate);
      });
    });

    it('should accept dates from previous months', async () => {
      renderWithRouter(<EntryWorkflow />);
      
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      
      // Set a date from several months ago
      const oldDate = '2023-06-10';
      fireEvent.change(dateInput, { target: { value: oldDate } });
      
      await waitFor(() => {
        expect(dateInput.value).toBe(oldDate);
      });
    });
  });

  describe('Requirement 12.3: Validate no future dates allowed', () => {
    it('should have max attribute set to today to prevent future dates in HTML5 input', () => {
      renderWithRouter(<EntryWorkflow />);
      
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      expect(dateInput).toBeInTheDocument();
      
      // Check max attribute is set to today
      const today = new Date();
      const expectedMax = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      expect(dateInput.getAttribute('max')).toBe(expectedMax);
    });

    it('should show validation error when trying to proceed with future date', async () => {
      renderWithRouter(<EntryWorkflow />);
      
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      
      // Manually set a future date (bypassing HTML5 validation for testing)
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 5);
      const futureDateString = `${futureDate.getFullYear()}-${String(futureDate.getMonth() + 1).padStart(2, '0')}-${String(futureDate.getDate()).padStart(2, '0')}`;
      
      fireEvent.change(dateInput, { target: { value: futureDateString } });
      
      // Try to proceed to next step
      const nextButton = screen.getByText('Next');
      fireEvent.click(nextButton);
      
      // Should show validation error
      await waitFor(() => {
        expect(screen.getByText('Entry date cannot be in the future')).toBeInTheDocument();
      });
    });
  });

  describe('Requirement 12.4: Include date in form submission', () => {
    it('should include entryDate when submitting the form', async () => {
      const mockCreate = vi.mocked(api.deliveryEntriesApi.create);
      mockCreate.mockResolvedValue({
        id: '123',
        userId: 'user-1',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 10.50,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      renderWithRouter(<EntryWorkflow />);
      
      // Step 1: Set date
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      const testDate = '2024-01-15';
      fireEvent.change(dateInput, { target: { value: testDate } });
      fireEvent.click(screen.getByText('Next'));
      
      // Step 2: Enter restaurant name
      await waitFor(() => {
        expect(screen.getByText('Restaurant Name')).toBeInTheDocument();
      });
      const nameInput = screen.getByPlaceholderText(/e.g., McDonald's/i);
      fireEvent.change(nameInput, { target: { value: 'Test Restaurant' } });
      fireEvent.click(screen.getByText('Next'));
      
      // Step 3: Select restaurant status
      await waitFor(() => {
        expect(screen.getByText('Restaurant Status')).toBeInTheDocument();
      });
      const halalRadio = screen.getByLabelText('Halal');
      fireEvent.click(halalRadio);
      fireEvent.click(screen.getByText('Next'));
      
      // Step 4: Enter fare amount
      await waitFor(() => {
        expect(screen.getByText('Fare Amount')).toBeInTheDocument();
      });
      const fareInput = screen.getByPlaceholderText('0.00');
      fireEvent.change(fareInput, { target: { value: '10.50' } });
      fireEvent.click(screen.getByText('Next'));
      
      // Step 5: Select no cash order
      await waitFor(() => {
        expect(screen.getByText('Cash Order')).toBeInTheDocument();
      });
      const noRadio = screen.getByLabelText('No');
      fireEvent.click(noRadio);
      
      // Submit button should appear since no cash order
      await waitFor(() => {
        expect(screen.getByText('Submit')).toBeInTheDocument();
      });
      fireEvent.click(screen.getByText('Submit'));
      
      // Verify API was called with date included
      await waitFor(() => {
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({
            restaurantName: 'Test Restaurant',
            restaurantStatus: 'halal',
            fareAmount: 10.50,
            hasCashOrder: false,
            entryDate: expect.any(Date),
          })
        );
      });
      
      // Verify the date value is correct
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.entryDate).toBeDefined();
      const submittedDate = new Date(callArgs.entryDate!);
      expect(submittedDate.toISOString().split('T')[0]).toBe(testDate);
    });
  });

  describe('Integration: Date step in workflow', () => {
    it('should show date as step 1 of 5 (or 6 with cash)', () => {
      renderWithRouter(<EntryWorkflow />);
      
      // Should show step 1 of 5 initially (no cash order selected yet)
      expect(screen.getByText(/Step 1 of 5/i)).toBeInTheDocument();
      expect(screen.getByText('Entry Date')).toBeInTheDocument();
    });

    it('should allow navigation back to date step', async () => {
      renderWithRouter(<EntryWorkflow />);
      
      // Go to step 2
      fireEvent.click(screen.getByText('Next'));
      
      await waitFor(() => {
        expect(screen.getByText('Restaurant Name')).toBeInTheDocument();
      });
      
      // Click previous
      fireEvent.click(screen.getByText('Previous'));
      
      // Should be back at date step
      await waitFor(() => {
        expect(screen.getByText('Entry Date')).toBeInTheDocument();
      });
    });
  });

  describe('Edge cases', () => {
    it('should handle today as a valid date', async () => {
      renderWithRouter(<EntryWorkflow />);
      
      const dateInput = document.querySelector('input[type="date"]') as HTMLInputElement;
      const today = new Date();
      const todayString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
      
      fireEvent.change(dateInput, { target: { value: todayString } });
      
      // Should not show error
      fireEvent.click(screen.getByText('Next'));
      
      await waitFor(() => {
        expect(screen.queryByText('Entry date cannot be in the future')).not.toBeInTheDocument();
        expect(screen.getByText('Restaurant Name')).toBeInTheDocument();
      });
    });
  });
});
