import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import FilterPanel, { FilterOptions } from './FilterPanel';

/**
 * FilterPanel Component Tests
 * 
 * Tests filtering functionality for:
 * - Date range filter (Requirements 8.2)
 * - Restaurant status filter (Requirements 8.3)
 * - Payment type filter (Requirements 8.4, 4.7)
 */

describe('FilterPanel', () => {
  it('renders all filter controls', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Check that all filter inputs are present
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/end date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/restaurant status/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/payment type/i)).toBeInTheDocument();
    
    // Check that buttons are present
    expect(screen.getByText(/apply filters/i)).toBeInTheDocument();
    expect(screen.getByText(/clear filters/i)).toBeInTheDocument();
  });

  it('applies date range filter correctly (Requirement 8.2)', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Set date range
    const startDateInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endDateInput = screen.getByLabelText(/end date/i) as HTMLInputElement;

    fireEvent.change(startDateInput, { target: { value: '2024-01-01' } });
    fireEvent.change(endDateInput, { target: { value: '2024-01-31' } });

    // Apply filters
    fireEvent.click(screen.getByText(/apply filters/i));

    // Check that callback was called with correct date range
    expect(mockApplyFilters).toHaveBeenCalledTimes(1);
    const calledFilters = mockApplyFilters.mock.calls[0][0] as FilterOptions;
    
    expect(calledFilters.startDate).toBeDefined();
    expect(calledFilters.endDate).toBeDefined();
    expect(calledFilters.startDate?.toISOString()).toContain('2024-01-01');
    expect(calledFilters.endDate?.toISOString()).toContain('2024-01-31');
  });

  it('applies restaurant status filter correctly (Requirement 8.3)', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Select halal restaurant status
    const statusSelect = screen.getByLabelText(/restaurant status/i) as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'halal' } });

    // Apply filters
    fireEvent.click(screen.getByText(/apply filters/i));

    // Check that callback was called with halal status
    expect(mockApplyFilters).toHaveBeenCalledTimes(1);
    const calledFilters = mockApplyFilters.mock.calls[0][0] as FilterOptions;
    expect(calledFilters.restaurantStatus).toBe('halal');
  });

  it('applies payment type filter correctly (Requirements 8.4, 4.7)', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Select cash payment type
    const paymentTypeSelect = screen.getByLabelText(/payment type/i) as HTMLSelectElement;
    fireEvent.change(paymentTypeSelect, { target: { value: 'cash' } });

    // Apply filters
    fireEvent.click(screen.getByText(/apply filters/i));

    // Check that callback was called with cash payment type
    expect(mockApplyFilters).toHaveBeenCalledTimes(1);
    const calledFilters = mockApplyFilters.mock.calls[0][0] as FilterOptions;
    expect(calledFilters.paymentType).toBe('cash');
  });

  it('does not include "both" values in applied filters', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Default values are "both", apply filters without changing
    fireEvent.click(screen.getByText(/apply filters/i));

    // Check that callback was called with empty filters (no "both" values)
    expect(mockApplyFilters).toHaveBeenCalledTimes(1);
    const calledFilters = mockApplyFilters.mock.calls[0][0] as FilterOptions;
    expect(calledFilters.restaurantStatus).toBeUndefined();
    expect(calledFilters.paymentType).toBeUndefined();
  });

  it('clears all filters when clear button is clicked', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Set some filters
    const startDateInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const statusSelect = screen.getByLabelText(/restaurant status/i) as HTMLSelectElement;
    const paymentTypeSelect = screen.getByLabelText(/payment type/i) as HTMLSelectElement;

    fireEvent.change(startDateInput, { target: { value: '2024-01-01' } });
    fireEvent.change(statusSelect, { target: { value: 'halal' } });
    fireEvent.change(paymentTypeSelect, { target: { value: 'cash' } });

    // Clear filters
    fireEvent.click(screen.getByText(/clear filters/i));

    // Check that inputs are reset
    expect(startDateInput.value).toBe('');
    expect(statusSelect.value).toBe('both');
    expect(paymentTypeSelect.value).toBe('both');

    // Check that callback was called
    expect(mockClearFilters).toHaveBeenCalledTimes(1);
  });

  it('applies multiple filters simultaneously', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
      />
    );

    // Set all filters
    const startDateInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endDateInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    const statusSelect = screen.getByLabelText(/restaurant status/i) as HTMLSelectElement;
    const paymentTypeSelect = screen.getByLabelText(/payment type/i) as HTMLSelectElement;

    fireEvent.change(startDateInput, { target: { value: '2024-01-01' } });
    fireEvent.change(endDateInput, { target: { value: '2024-01-31' } });
    fireEvent.change(statusSelect, { target: { value: 'non-halal' } });
    fireEvent.change(paymentTypeSelect, { target: { value: 'digital' } });

    // Apply filters
    fireEvent.click(screen.getByText(/apply filters/i));

    // Check that all filters are included
    expect(mockApplyFilters).toHaveBeenCalledTimes(1);
    const calledFilters = mockApplyFilters.mock.calls[0][0] as FilterOptions;
    
    expect(calledFilters.startDate).toBeDefined();
    expect(calledFilters.endDate).toBeDefined();
    expect(calledFilters.restaurantStatus).toBe('non-halal');
    expect(calledFilters.paymentType).toBe('digital');
  });

  it('initializes with provided initial filters', () => {
    const mockApplyFilters = vi.fn();
    const mockClearFilters = vi.fn();
    
    const initialFilters: FilterOptions = {
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-01-31'),
      restaurantStatus: 'halal',
      paymentType: 'cash',
    };

    render(
      <FilterPanel
        onApplyFilters={mockApplyFilters}
        onClearFilters={mockClearFilters}
        initialFilters={initialFilters}
      />
    );

    // Check that inputs are initialized with correct values
    const startDateInput = screen.getByLabelText(/start date/i) as HTMLInputElement;
    const endDateInput = screen.getByLabelText(/end date/i) as HTMLInputElement;
    const statusSelect = screen.getByLabelText(/restaurant status/i) as HTMLSelectElement;
    const paymentTypeSelect = screen.getByLabelText(/payment type/i) as HTMLSelectElement;

    expect(startDateInput.value).toBe('2024-01-01');
    expect(endDateInput.value).toBe('2024-01-31');
    expect(statusSelect.value).toBe('halal');
    expect(paymentTypeSelect.value).toBe('cash');
  });
});
