import { useState } from 'react';
import type { RestaurantStatus } from '../types';

/**
 * FilterPanel Component
 * 
 * Provides filtering controls for dashboard entries:
 * - Date range filter (start date, end date)
 * - Restaurant status filter (halal, non-halal, both)
 * - Payment type filter (cash, digital, both)
 * 
 * Validates Requirements: 8.2, 8.3, 8.4, 4.7
 */

export interface FilterOptions {
  startDate?: string;
  endDate?: string;
  restaurantStatus?: RestaurantStatus | 'both';
  paymentType?: 'cash' | 'digital' | 'both';
}

export interface AppliedFilterResult {
  readonly kind: 'applied';
  readonly filters: FilterOptions;
}

export interface InvalidFilterApplyResult {
  readonly kind: 'invalid';
  readonly reason: 'reversed-date-range';
  readonly message: string;
  readonly retainedFilters: FilterOptions;
  readonly draftDates: Readonly<{ startDate: string; endDate: string }>;
}

export interface ClearedFilterResult {
  readonly kind: 'cleared';
  readonly filters: FilterOptions;
}

interface FilterPanelProps {
  onApplyFilters: (filters: FilterOptions, result: AppliedFilterResult) => void;
  onInvalidApply?: (result: InvalidFilterApplyResult) => void;
  onClearFilters: (result: ClearedFilterResult) => void;
  initialFilters?: FilterOptions;
}

export default function FilterPanel({
  onApplyFilters,
  onInvalidApply,
  onClearFilters,
  initialFilters = {},
}: FilterPanelProps) {
  // These values are drafts only; parent callbacks own the applied filter state.
  const [startDate, setStartDate] = useState<string>(initialFilters.startDate ?? '');
  const [endDate, setEndDate] = useState<string>(initialFilters.endDate ?? '');
  const [restaurantStatus, setRestaurantStatus] = useState<'halal' | 'non-halal' | 'both'>(
    initialFilters.restaurantStatus || 'both'
  );
  const [paymentType, setPaymentType] = useState<'cash' | 'digital' | 'both'>(
    initialFilters.paymentType || 'both'
  );

  const buildNonDateFilters = (): FilterOptions => ({
    ...(restaurantStatus !== 'both' ? { restaurantStatus } : {}),
    ...(paymentType !== 'both' ? { paymentType } : {}),
  });

  const handleApplyFilters = () => {
    const retainedFilters = buildNonDateFilters();
    const normalizedStartDate = startDate || endDate;
    const normalizedEndDate = endDate || startDate;

    if (normalizedStartDate && normalizedEndDate && normalizedStartDate > normalizedEndDate) {
      onInvalidApply?.({
        kind: 'invalid',
        reason: 'reversed-date-range',
        message: 'Start date must be on or before end date.',
        retainedFilters,
        draftDates: { startDate, endDate },
      });
      return;
    }

    const filters: FilterOptions = {
      ...(normalizedStartDate ? { startDate: normalizedStartDate } : {}),
      ...(normalizedEndDate ? { endDate: normalizedEndDate } : {}),
      ...retainedFilters,
    };

    onApplyFilters(filters, { kind: 'applied', filters });
  };

  const handleClearFilters = () => {
    setStartDate('');
    setEndDate('');
    setRestaurantStatus('both');
    setPaymentType('both');
    onClearFilters({ kind: 'cleared', filters: {} });
  };

  return (
    <section className="filter-panel bg-white shadow rounded-lg p-6 mb-6" aria-labelledby="filter-panel-heading">
      <h2 id="filter-panel-heading" className="text-lg font-medium text-gray-900 mb-4">Filters</h2>

      <form onSubmit={(event) => { event.preventDefault(); handleApplyFilters(); }}>
        <div className="filter-panel__fields grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label htmlFor="startDate" className="block text-sm font-medium text-gray-700 mb-1">
              Start Date
            </label>
            <input
              type="date"
              id="startDate"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          <div>
            <label htmlFor="endDate" className="block text-sm font-medium text-gray-700 mb-1">
              End Date
            </label>
            <input
              type="date"
              id="endDate"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            />
          </div>

          <div>
            <label htmlFor="restaurantStatus" className="block text-sm font-medium text-gray-700 mb-1">
              Restaurant Status
            </label>
            <select
              id="restaurantStatus"
              value={restaurantStatus}
              onChange={(e) => setRestaurantStatus(e.target.value as 'halal' | 'non-halal' | 'both')}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            >
              <option value="both">Both</option>
              <option value="halal">Halal</option>
              <option value="non-halal">Non-Halal</option>
            </select>
          </div>

          <div>
            <label htmlFor="paymentType" className="block text-sm font-medium text-gray-700 mb-1">
              Payment Type
            </label>
            <select
              id="paymentType"
              value={paymentType}
              onChange={(e) => setPaymentType(e.target.value as 'cash' | 'digital' | 'both')}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 sm:text-sm px-3 py-2 border"
            >
              <option value="both">Both</option>
              <option value="cash">Cash Only</option>
              <option value="digital">Digital Only</option>
            </select>
          </div>
        </div>

        <div className="filter-panel__actions mt-6 flex gap-3">
          <button
            type="submit"
            className="inline-flex justify-center rounded-md border border-transparent bg-indigo-600 py-2 px-4 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            Apply Filters
          </button>
          <button
            type="button"
            onClick={handleClearFilters}
            className="inline-flex justify-center rounded-md border border-gray-300 bg-white py-2 px-4 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
          >
            Clear Filters
          </button>
        </div>
      </form>
    </section>
  );
}
