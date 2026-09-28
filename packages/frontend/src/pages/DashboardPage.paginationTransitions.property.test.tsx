import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import fc from 'fast-check';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryEntry, IncomeTotals } from '../types';
import { analyticsApi, deliveryEntriesApi, type DeliveryEntryPage } from '../services/api';
import DashboardPage from './DashboardPage';

vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => vi.fn(),
}));
vi.mock('../hooks/useAuth', () => ({
  useAuth: () => ({ user: { email: 'driver@example.com' }, logout: vi.fn() }),
}));
vi.mock('../components/BulkReportPanel', () => ({ default: () => null }));
vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    deliveryEntriesApi: { ...actual.deliveryEntriesApi, getAll: vi.fn() },
    analyticsApi: { ...actual.analyticsApi, getTotals: vi.fn() },
  };
});

const pageSize = 10;
const totalEntries = 100;

const entry: DeliveryEntry = {
  id: 'entry-1',
  userId: 'user-1',
  restaurantName: 'Pagination Restaurant',
  restaurantStatus: 'halal',
  fareAmount: 12,
  hasCashOrder: false,
  entryDate: new Date('2025-01-01T00:00:00.000Z'),
  timestamp: new Date('2025-01-01T01:00:00.000Z'),
  createdAt: new Date('2025-01-01T01:00:00.000Z'),
  updatedAt: new Date('2025-01-01T01:00:00.000Z'),
};

const entryPage: DeliveryEntryPage = { entries: [entry], total: totalEntries };
const totals: IncomeTotals = {
  totalHalalIncome: 12,
  totalNonHalalIncome: 0,
  totalCashIncome: 0,
  totalDigitalIncome: 12,
};

type NavigationAction =
  | { kind: 'next' }
  | { kind: 'previous' };
type FilterAction =
  | { kind: 'apply-status'; value: 'halal' | 'non-halal' | 'both' }
  | { kind: 'apply-payment'; value: 'cash' | 'digital' | 'both' }
  | { kind: 'apply-date-range'; startDay: number; endDay: number }
  | { kind: 'clear' };
type DashboardAction = NavigationAction | FilterAction;

const navigationAction: fc.Arbitrary<NavigationAction> = fc.constantFrom(
  { kind: 'next' } as const,
  { kind: 'previous' } as const,
);
const filterAction: fc.Arbitrary<FilterAction> = fc.oneof(
  fc.constantFrom<'halal' | 'non-halal' | 'both'>('halal', 'non-halal', 'both')
    .map((value) => ({ kind: 'apply-status' as const, value })),
  fc.constantFrom<'cash' | 'digital' | 'both'>('cash', 'digital', 'both')
    .map((value) => ({ kind: 'apply-payment' as const, value })),
  fc
    .tuple(fc.integer({ min: 1, max: 28 }), fc.integer({ min: 1, max: 28 }))
    .map(([firstDay, secondDay]) => ({
      kind: 'apply-date-range' as const,
      startDay: Math.min(firstDay, secondDay),
      endDay: Math.max(firstDay, secondDay),
    })),
  fc.constant({ kind: 'clear' } as const),
);
const actionSequence: fc.Arbitrary<DashboardAction[]> = fc.array(
  fc.oneof(navigationAction, filterAction),
  { minLength: 1, maxLength: 3 },
);

const renderDashboard = () => render(
  <MemoryRouter>
    <DashboardPage />
  </MemoryRouter>,
);

const dateForDay = (day: number): string => `2025-01-${String(day).padStart(2, '0')}`;

const applyFilterAction = (action: FilterAction): void => {
  switch (action.kind) {
    case 'apply-status':
      fireEvent.change(screen.getByLabelText('Restaurant Status'), { target: { value: action.value } });
      break;
    case 'apply-payment':
      fireEvent.change(screen.getByLabelText('Payment Type'), { target: { value: action.value } });
      break;
    case 'apply-date-range':
      fireEvent.change(screen.getByLabelText('Start Date'), {
        target: { value: dateForDay(action.startDay) },
      });
      fireEvent.change(screen.getByLabelText('End Date'), {
        target: { value: dateForDay(action.endDay) },
      });
      break;
    case 'clear':
      fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
      return;
  }

  fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardPage filter-change pagination transition property', () => {
  // Feature: daily-malaysia-income-totals, Property 11: Filter-Change Pagination Transition
  // **Validates: Requirements 3.9, 6.10**
  it('uses zero after every filter action and the requested offset for every navigation action', async () => {
    await fc.assert(
      fc.asyncProperty(actionSequence, async (actions) => {
        vi.clearAllMocks();
        vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue(entryPage);
        vi.mocked(analyticsApi.getTotals).mockResolvedValue(totals);

        const view = renderDashboard();
        try {
          await screen.findByText('Pagination Restaurant');
          let expectedOffset = 0;
          let expectedRequestCount = 1;

          for (const action of actions) {
            if (action.kind === 'next') {
              if (expectedOffset + pageSize >= totalEntries) continue;
              expectedOffset += pageSize;
              fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
            } else if (action.kind === 'previous') {
              if (expectedOffset === 0) continue;
              expectedOffset -= pageSize;
              fireEvent.click(screen.getAllByRole('button', { name: 'Previous' })[0]);
            } else {
              expectedOffset = 0;
              applyFilterAction(action);
            }

            expectedRequestCount += 1;
            await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(expectedRequestCount));
            const request = vi.mocked(deliveryEntriesApi.getAll).mock.calls.at(-1)?.[0];
            expect(request).toEqual(expect.objectContaining({ limit: pageSize, offset: expectedOffset }));
          }
        } finally {
          view.unmount();
        }
      }),
      { numRuns: 125 },
    );
  }, 30_000);
});
