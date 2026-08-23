import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import {
  createMalaysiaMidnightRefreshController,
  type MalaysiaMidnightRefreshController,
} from '../hooks/malaysiaMidnightRefresh';
import {
  DashboardApiError,
  deliveryEntriesApi,
  analyticsApi,
  type DashboardFilterQuery,
  type DeliveryEntryPage,
} from '../services/api';
import type { DeliveryEntry, IncomeTotals } from '../types';
import { formatDate, formatDateTime, formatTimestamp } from '../utils/dateFormat';
import { showSuccess, showError } from '../utils/toast';
import FilterPanel, {
  type AppliedFilterResult,
  type ClearedFilterResult,
  type FilterOptions,
  type InvalidFilterApplyResult,
} from '../components/FilterPanel';

type AppliedFilterOptions = DashboardFilterQuery;

const SUSPENDED_MIDNIGHT_SCOPE = { startDate: '__suspended__' } as const;
const suspendedMidnightRefresh = async (): Promise<void> => {};

const toNonDateFilters = (filters: AppliedFilterOptions): AppliedFilterOptions => ({
  ...(filters.restaurantStatus ? { restaurantStatus: filters.restaurantStatus } : {}),
  ...(filters.paymentType ? { paymentType: filters.paymentType } : {}),
});

const toAppliedFilters = (filters: FilterOptions): AppliedFilterOptions => ({
  ...(filters.startDate ? { startDate: filters.startDate } : {}),
  ...(filters.endDate ? { endDate: filters.endDate } : {}),
  ...(filters.restaurantStatus && filters.restaurantStatus !== 'both'
    ? { restaurantStatus: filters.restaurantStatus }
    : {}),
  ...(filters.paymentType && filters.paymentType !== 'both'
    ? { paymentType: filters.paymentType }
    : {}),
});

export type DashboardDataState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: DeliveryEntryPage; totals: IncomeTotals }
  | { kind: 'validation-error'; message: string }
  | { kind: 'load-error'; message: string };

type DashboardViewState = {
  data: DashboardDataState;
  refreshError: string | null;
};

const errorMessageFor = (error: unknown): string =>
  error instanceof Error ? error.message : 'Failed to load data';

const isUnauthorizedError = (error: unknown): boolean => {
  const message = errorMessageFor(error);
  return message.includes('Unauthorized') || message.includes('Invalid token');
};

/**
 * DashboardPage - Main application dashboard
 * 
 * Features:
 * - Display delivery entries
 * - Show income totals (halal/non-halal, cash/digital)
 * - Filtering and pagination
 * - Entry creation, editing, and deletion
 * - Uses AuthContext for user state and logout
 * 
 * Validates Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 4.7, 1.3
 */
export default function DashboardPage() {
  const navigate = useNavigate();
  const { logout: authLogout } = useAuth();
  const [dashboardView, setDashboardView] = useState<DashboardViewState>({
    data: { kind: 'loading' },
    refreshError: null,
  });
  const [mutationError, setMutationError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [deletingEntryId, setDeletingEntryId] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const requestControllerRef = useRef<AbortController | null>(null);
  const midnightControllerRef = useRef<MalaysiaMidnightRefreshController | null>(null);
  const [filterValidationBlocked, setFilterValidationBlocked] = useState(false);
  
  // Pagination state
  const [limit] = useState(10); // Items per page (fixed at 10)
  const [offset, setOffset] = useState(0); // Current offset
  const [activeFilters, setActiveFilters] = useState<AppliedFilterOptions>({});

  const preserveUnauthorizedBehavior = useCallback((error: unknown): void => {
    if (!isUnauthorizedError(error)) return;
    localStorage.removeItem('authToken');
    navigate('/login');
  }, [navigate]);

  const suspendMidnightRefresh = useCallback((): void => {
    midnightControllerRef.current?.update({
      scope: SUSPENDED_MIDNIGHT_SCOPE,
      refreshTotals: suspendedMidnightRefresh,
    });
  }, []);

  const cancelDashboardLoad = useCallback(() => {
    requestGenerationRef.current += 1;
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    suspendMidnightRefresh();
  }, [suspendMidnightRefresh]);

  const activateMidnightRefresh = useCallback((
    filters: AppliedFilterOptions,
    owningGeneration: number,
  ): void => {
    if (filters.startDate || filters.endDate) return;

    const nonDateFilters = toNonDateFilters(filters);
    midnightControllerRef.current?.update({
      scope: filters,
      refreshTotals: async ({ signal }) => {
        try {
          const refreshedTotals = await analyticsApi.getTotals(
            nonDateFilters,
            { signal },
          );

          if (signal.aborted || owningGeneration !== requestGenerationRef.current) return;
          setDashboardView((current) => {
            if (
              signal.aborted
              || owningGeneration !== requestGenerationRef.current
              || current.data.kind !== 'ready'
            ) {
              return current;
            }

            return {
              ...current,
              data: { ...current.data, totals: refreshedTotals },
            };
          });
        } catch (error) {
          if (!signal.aborted && owningGeneration === requestGenerationRef.current) {
            preserveUnauthorizedBehavior(error);
          }
          throw error;
        }
      },
    });
  }, [preserveUnauthorizedBehavior]);

  const loadDashboard = useCallback(async (): Promise<void> => {
    const generation = ++requestGenerationRef.current;
    const filtersForLoad = activeFilters;
    requestControllerRef.current?.abort();
    suspendMidnightRefresh();

    const controller = new AbortController();
    requestControllerRef.current = controller;
    setDashboardView((current) => ({ ...current, data: { kind: 'loading' } }));

    const [entriesResult, totalsResult] = await Promise.allSettled([
      deliveryEntriesApi.getAll(
        { ...filtersForLoad, limit, offset },
        { signal: controller.signal },
      ),
      analyticsApi.getTotals(filtersForLoad, { signal: controller.signal }),
    ]);

    if (controller.signal.aborted || generation !== requestGenerationRef.current) {
      return;
    }

    if (entriesResult.status === 'fulfilled' && totalsResult.status === 'fulfilled') {
      setDashboardView({
        data: {
          kind: 'ready',
          entries: entriesResult.value,
          totals: totalsResult.value,
        },
        refreshError: null,
      });
      activateMidnightRefresh(filtersForLoad, generation);
    } else {
      const failures = [entriesResult, totalsResult]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason as unknown);
      const failure = failures.find(isUnauthorizedError) ?? failures[0];
      const message = errorMessageFor(failure);
      const kind = failure instanceof DashboardApiError && failure.status === 400
        ? 'validation-error'
        : 'load-error';

      setDashboardView((current) => ({
        ...current,
        data: { kind, message },
      }));
      preserveUnauthorizedBehavior(failure);
    }

    if (requestControllerRef.current === controller) {
      requestControllerRef.current = null;
    }
  }, [
    activeFilters,
    activateMidnightRefresh,
    limit,
    offset,
    preserveUnauthorizedBehavior,
    suspendMidnightRefresh,
  ]);

  useEffect(() => {
    const controller = createMalaysiaMidnightRefreshController({
      scope: SUSPENDED_MIDNIGHT_SCOPE,
      refreshTotals: suspendedMidnightRefresh,
      onRefreshError: (error) => {
        setDashboardView((current) => ({
          ...current,
          refreshError: error === null
            ? null
            : `Unable to refresh daily totals: ${errorMessageFor(error)}`,
        }));
        if (error !== null) preserveUnauthorizedBehavior(error);
      },
    });
    midnightControllerRef.current = controller;

    return () => {
      controller.dispose();
      if (midnightControllerRef.current === controller) {
        midnightControllerRef.current = null;
      }
    };
  }, [preserveUnauthorizedBehavior]);

  useEffect(() => {
    if (filterValidationBlocked) {
      cancelDashboardLoad();
      return;
    }

    void loadDashboard();

    return cancelDashboardLoad;
  }, [cancelDashboardLoad, filterValidationBlocked, loadDashboard]);

  const readyData = dashboardView.data.kind === 'ready' ? dashboardView.data : null;
  const entries = readyData?.entries.entries ?? [];
  const total = readyData?.entries.total ?? 0;
  const totals = readyData?.totals ?? null;
  const dashboardError = dashboardView.data.kind === 'validation-error'
    || dashboardView.data.kind === 'load-error'
    ? dashboardView.data.message
    : '';

  const handleLogout = async () => {
    try {
      await authLogout();
      navigate('/login');
    } catch (err) {
      console.error('Logout error:', err);
      // Still navigate to login even if logout fails
      navigate('/login');
    }
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency: 'MYR',
    }).format(amount);
  };

  /**
   * Handle entry deletion with confirmation
   * Validates Requirements: 14.3, 14.4
   */
  const handleDeleteEntry = async (entry: DeliveryEntry) => {
    // Show confirmation dialog with entry details (Requirement 14.3)
    const confirmMessage = `Delete delivery from ${entry.restaurantName} for ${formatCurrency(entry.fareAmount)}${
      entry.hasCashOrder && entry.cashAmount
        ? ` + ${formatCurrency(entry.cashAmount)} cash`
        : ''
    }?`;

    if (!window.confirm(confirmMessage)) {
      return; // User cancelled
    }

    setDeletingEntryId(entry.id);
    setMutationError('');
    setSuccessMessage('');

    try {
      // Call DELETE API
      await deliveryEntriesApi.delete(entry.id);

      // Show success toast
      showSuccess('Entry deleted successfully');

      // Refresh dashboard data - this will recalculate totals (Requirement 14.4)
      await loadDashboard();
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete entry';
      setMutationError(errorMessage);
      showError(errorMessage);

      // If unauthorized, redirect to login
      if (errorMessage.includes('Unauthorized') || errorMessage.includes('Invalid token')) {
        localStorage.removeItem('authToken');
        navigate('/login');
      }
    } finally {
      setDeletingEntryId(null);
    }
  };

  // Pagination handlers and calculations
  const currentPage = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  const startEntry = total === 0 ? 0 : offset + 1;
  const endEntry = Math.min(offset + limit, total);

  const handlePreviousPage = () => {
    if (offset > 0) {
      setOffset(Math.max(0, offset - limit));
    }
  };

  const handleNextPage = () => {
    if (offset + limit < total) {
      setOffset(offset + limit);
    }
  };

  const handlePageJump = (page: number) => {
    const newOffset = (page - 1) * limit;
    if (newOffset >= 0 && newOffset < total) {
      setOffset(newOffset);
    }
  };

  const handleApplyFilters = (_filters: FilterOptions, result: AppliedFilterResult) => {
    suspendMidnightRefresh();
    setFilterValidationBlocked(false);
    setActiveFilters(toAppliedFilters(result.filters));
    setOffset(0);
  };

  const handleInvalidFilterApply = (result: InvalidFilterApplyResult) => {
    cancelDashboardLoad();
    setFilterValidationBlocked(true);
    setActiveFilters(toAppliedFilters(result.retainedFilters));
    setOffset(0);
    setDashboardView({
      data: { kind: 'validation-error', message: result.message },
      refreshError: null,
    });
  };

  const handleClearFilters = (result: ClearedFilterResult) => {
    suspendMidnightRefresh();
    setFilterValidationBlocked(false);
    setActiveFilters(toAppliedFilters(result.filters));
    setOffset(0);
  };

  if (dashboardView.data.kind === 'loading') {
    return (
      <div className="dashboard-page min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="rounded-lg bg-white px-6 py-5 text-center text-gray-600 shadow-sm">Loading...</div>
      </div>
    );
  }

  return (
    <div className="dashboard-page min-h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white shadow">
        <div className="max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8 flex justify-between items-center">
          <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
          <button
            onClick={handleLogout}
            className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-md"
          >
            Logout
          </button>
        </div>
      </header>

      <main className="dashboard-main max-w-7xl mx-auto py-6 px-4 sm:px-6 lg:px-8">
        <aside
          role="status"
          aria-label="Development notice"
          className="mb-6 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium leading-6 text-amber-950 shadow-sm whitespace-normal break-words sm:text-base"
        >
          The system is still under development. More features are coming soon!
        </aside>

        {(dashboardError || mutationError) && (
          <div className="mb-4 rounded-md bg-red-50 p-4" role="alert">
            <div className="text-sm text-red-800">{dashboardError || mutationError}</div>
          </div>
        )}

        {dashboardView.refreshError && (
          <div className="mb-4 rounded-md bg-amber-50 p-4" role="status">
            <div className="text-sm text-amber-800">{dashboardView.refreshError}</div>
          </div>
        )}

        {successMessage && (
          <div className="mb-4 rounded-md bg-green-50 p-4">
            <div className="text-sm text-green-800">{successMessage}</div>
          </div>
        )}

        {/* Income Totals */}
        {totals && (
          <dl className="dashboard-totals grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4 mb-8" aria-label="Income totals">
            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Total Halal Income
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-green-600">
                  {formatCurrency(totals.totalHalalIncome)}
                </dd>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Total Non-Halal Income
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-orange-600">
                  {formatCurrency(totals.totalNonHalalIncome)}
                </dd>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Total Cash Income
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-blue-600">
                  {formatCurrency(totals.totalCashIncome)}
                </dd>
              </div>
            </div>

            <div className="bg-white overflow-hidden shadow rounded-lg">
              <div className="px-4 py-5 sm:p-6">
                <dt className="text-sm font-medium text-gray-500 truncate">
                  Total Digital Income
                </dt>
                <dd className="mt-1 text-3xl font-semibold text-purple-600">
                  {formatCurrency(totals.totalDigitalIncome)}
                </dd>
              </div>
            </div>
          </dl>
        )}

        <section className="dashboard-workspace" aria-label="Delivery entry workspace">
          <aside className="dashboard-filters" aria-label="Filter delivery entries">
            <FilterPanel
              onApplyFilters={handleApplyFilters}
              onInvalidApply={handleInvalidFilterApply}
              onClearFilters={handleClearFilters}
              initialFilters={activeFilters}
            />
          </aside>

          {readyData && (
            <section className="dashboard-entries bg-white shadow overflow-hidden sm:rounded-lg" aria-labelledby="recent-deliveries-heading">
          <div className="dashboard-entries__header px-4 py-5 sm:px-6 flex justify-between items-center">
            <div>
              <h2 id="recent-deliveries-heading" className="text-lg leading-6 font-medium text-gray-900">
                Recent Deliveries
              </h2>
              {total > 0 && (
                <p className="mt-1 text-sm text-gray-500">
                  Showing {startEntry}-{endEntry} of {total} entries
                </p>
              )}
            </div>
            <button
              onClick={() => navigate('/entry')}
              className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-md"
            >
              New Entry
            </button>
          </div>
          <div className="border-t border-gray-200">
            {entries.length === 0 ? (
              <div className="px-4 py-12 text-center text-gray-500">
                No entries found. Create your first delivery entry!
              </div>
            ) : (
              <>
                <ul className="divide-y divide-gray-200">
                  {entries.map((entry) => (
                    <li key={entry.id} className="px-4 py-4 sm:px-6 hover:bg-gray-50">
                      <article className="dashboard-entry flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center space-x-3">
                            <span
                              className={`px-2 py-1 text-xs font-medium rounded-full ${
                                entry.restaurantStatus === 'halal'
                                  ? 'bg-green-100 text-green-800'
                                  : 'bg-orange-100 text-orange-800'
                              }`}
                            >
                              {entry.restaurantStatus}
                            </span>
                            <p className="text-sm font-medium text-gray-900 truncate">
                              {entry.restaurantName}
                            </p>
                          </div>
                          <div className="mt-2 flex items-center text-sm text-gray-500 space-x-4">
                            <span>Fare: {formatCurrency(entry.fareAmount)}</span>
                            {entry.hasCashOrder && entry.cashAmount && (
                              <span>Cash: {formatCurrency(entry.cashAmount)}</span>
                            )}
                            <span title={formatDateTime(entry.entryDate)}>
                              {formatDate(entry.entryDate)}
                            </span>
                          </div>
                          {entry.createdAt && (
                            <div className="mt-1 text-xs text-gray-400">
                              Created: {formatTimestamp(entry.createdAt)}
                            </div>
                          )}
                        </div>
                        <div className="dashboard-entry__actions flex space-x-2">
                          <button
                            onClick={() => navigate(`/entry/${entry.id}`)}
                            className="text-indigo-600 hover:text-indigo-900 text-sm font-medium"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => handleDeleteEntry(entry)}
                            disabled={deletingEntryId === entry.id}
                            className="text-red-600 hover:text-red-900 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                            title={deletingEntryId === entry.id ? 'Deleting...' : 'Delete entry'}
                          >
                            {deletingEntryId === entry.id ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      </article>
                    </li>
                  ))}
                </ul>

                {/* Pagination Controls */}
                {totalPages > 1 && (
                  <div className="bg-white px-4 py-3 flex items-center justify-between border-t border-gray-200 sm:px-6">
                    <div className="flex-1 flex justify-between sm:hidden">
                      {/* Mobile pagination */}
                      <button
                        onClick={handlePreviousPage}
                        disabled={offset === 0}
                        className={`relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md ${
                          offset === 0
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        Previous
                      </button>
                      <button
                        onClick={handleNextPage}
                        disabled={offset + limit >= total}
                        className={`ml-3 relative inline-flex items-center px-4 py-2 border border-gray-300 text-sm font-medium rounded-md ${
                          offset + limit >= total
                            ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                            : 'bg-white text-gray-700 hover:bg-gray-50'
                        }`}
                      >
                        Next
                      </button>
                    </div>
                    <div className="hidden sm:flex-1 sm:flex sm:items-center sm:justify-between">
                      <div>
                        <p className="text-sm text-gray-700">
                          Page <span className="font-medium">{currentPage}</span> of{' '}
                          <span className="font-medium">{totalPages}</span>
                        </p>
                      </div>
                      <div>
                        <nav className="relative z-0 inline-flex rounded-md shadow-sm -space-x-px" aria-label="Pagination">
                          <button
                            onClick={handlePreviousPage}
                            disabled={offset === 0}
                            className={`relative inline-flex items-center px-2 py-2 rounded-l-md border border-gray-300 text-sm font-medium ${
                              offset === 0
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-white text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            <span className="sr-only">Previous</span>
                            <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fillRule="evenodd" d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z" clipRule="evenodd" />
                            </svg>
                          </button>
                          
                          {/* Page numbers */}
                          {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                            let pageNum: number;
                            if (totalPages <= 5) {
                              pageNum = i + 1;
                            } else if (currentPage <= 3) {
                              pageNum = i + 1;
                            } else if (currentPage >= totalPages - 2) {
                              pageNum = totalPages - 4 + i;
                            } else {
                              pageNum = currentPage - 2 + i;
                            }
                            
                            return (
                              <button
                                key={pageNum}
                                onClick={() => handlePageJump(pageNum)}
                                className={`relative inline-flex items-center px-4 py-2 border text-sm font-medium ${
                                  currentPage === pageNum
                                    ? 'z-10 bg-indigo-50 border-indigo-500 text-indigo-600'
                                    : 'bg-white border-gray-300 text-gray-500 hover:bg-gray-50'
                                }`}
                              >
                                {pageNum}
                              </button>
                            );
                          })}
                          
                          <button
                            onClick={handleNextPage}
                            disabled={offset + limit >= total}
                            className={`relative inline-flex items-center px-2 py-2 rounded-r-md border border-gray-300 text-sm font-medium ${
                              offset + limit >= total
                                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                                : 'bg-white text-gray-500 hover:bg-gray-50'
                            }`}
                          >
                            <span className="sr-only">Next</span>
                            <svg className="h-5 w-5" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fillRule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clipRule="evenodd" />
                            </svg>
                          </button>
                        </nav>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
            </section>
          )}
        </section>
      </main>
    </div>
  );
}
