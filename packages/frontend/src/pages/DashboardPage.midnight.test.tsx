import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryEntry, IncomeTotals } from '../types';
import { analyticsApi, deliveryEntriesApi, type DeliveryEntryPage } from '../services/api';
import DashboardPage from './DashboardPage';

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};
const entry: DeliveryEntry = {
  id: 'entry-1',
  userId: 'user-1',
  restaurantName: 'Preserved Restaurant',
  restaurantStatus: 'halal',
  fareAmount: 12,
  hasCashOrder: false,
  entryDate: new Date('2025-01-01T00:00:00.000Z'),
  timestamp: new Date('2025-01-01T01:00:00.000Z'),
  createdAt: new Date('2025-01-01T01:00:00.000Z'),
  updatedAt: new Date('2025-01-01T01:00:00.000Z'),
};
const page: DeliveryEntryPage = { entries: [entry], total: 1 };
const totals = (halal: number): IncomeTotals => ({
  totalHalalIncome: halal,
  totalNonHalalIncome: 2,
  totalCashIncome: 3,
  totalDigitalIncome: 4,
});

const renderDashboard = () => render(
  <MemoryRouter>
    <DashboardPage />
  </MemoryRouter>,
);

const flushDashboard = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
  });
};

const expectHalalTotal = (amount: number): void => {
  expect(within(screen.getByLabelText('Income totals')).getByText(
    new RegExp(`RM\\s+${amount.toFixed(2)}`),
  )).toBeInTheDocument();
};

describe('DashboardPage Malaysian midnight integration', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T15:59:59.000Z'));
    vi.clearAllMocks();
    localStorage.setItem('authToken', 'token');
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });
  it('refreshes only totals at midnight with the active non-date filters', async () => {
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue(page);
    vi.mocked(analyticsApi.getTotals)
      .mockResolvedValueOnce(totals(10))
      .mockResolvedValueOnce(totals(20))
      .mockResolvedValueOnce(totals(30));

    renderDashboard();
    await flushDashboard();
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Restaurant Status'), { target: { value: 'halal' } });
    fireEvent.change(screen.getByLabelText('Payment Type'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    await flushDashboard();
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(2);
    expectHalalTotal(20);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));

    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(2);
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(3);
    expect(analyticsApi.getTotals).toHaveBeenLastCalledWith(
      { restaurantStatus: 'halal', paymentType: 'cash' },
      { signal: expect.any(AbortSignal) },
    );
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();
    expectHalalTotal(30);
  });

  it('preserves ready data and shows a separate warning after the final rejection', async () => {
    const refreshFailure = new Error('totals unavailable');
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue(page);
    vi.mocked(analyticsApi.getTotals)
      .mockResolvedValueOnce(totals(10))
      .mockRejectedValue(refreshFailure);

    renderDashboard();
    await flushDashboard();
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(91_000));

    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(1);
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(5);
    const refreshWarning = screen.getByText(
      'Unable to refresh daily totals: totals unavailable',
    );
    expect(refreshWarning.closest('[role="status"]')).toBeInTheDocument();
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();
    expectHalalTotal(10);
  });
  it('keeps explicit dates inactive and resumes only after the clear load succeeds', async () => {
    const clearEntries = deferred<DeliveryEntryPage>();
    const clearTotals = deferred<IncomeTotals>();
    vi.mocked(deliveryEntriesApi.getAll)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce(page)
      .mockReturnValueOnce(clearEntries.promise)
      .mockResolvedValue(page);
    vi.mocked(analyticsApi.getTotals)
      .mockResolvedValueOnce(totals(10))
      .mockResolvedValueOnce(totals(20))
      .mockReturnValueOnce(clearTotals.promise)
      .mockResolvedValue(totals(40));

    renderDashboard();
    await flushDashboard();
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2024-12-01' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2024-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    await flushDashboard();
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(2);

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    await flushDashboard();
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000));
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(3);

    await act(async () => {
      clearEntries.resolve(page);
      clearTotals.resolve(totals(30));
      for (let index = 0; index < 6; index += 1) await Promise.resolve();
    });
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();
    expectHalalTotal(30);

    await act(async () => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000));
    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(3);
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(4);
    expectHalalTotal(40);
  });
  it('aborts and ignores a stale midnight result after the filter generation changes', async () => {
    const staleRefresh = deferred<IncomeTotals>();
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue(page);
    vi.mocked(analyticsApi.getTotals)
      .mockResolvedValueOnce(totals(10))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValueOnce(totals(40));

    renderDashboard();
    await flushDashboard();
    expect(screen.getByText('Preserved Restaurant')).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const staleSignal = vi.mocked(analyticsApi.getTotals).mock.calls[1][1]?.signal;
    expect(staleSignal?.aborted).toBe(false);

    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2024-12-01' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2024-12-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

    await flushDashboard();
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(3);
    expect(staleSignal?.aborted).toBe(true);
    expectHalalTotal(40);

    await act(async () => staleRefresh.resolve(totals(99)));
    expectHalalTotal(40);
    expect(within(screen.getByLabelText('Income totals')).queryByText(/RM\s+99\.00/))
      .not.toBeInTheDocument();
    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(2);
  });
});
