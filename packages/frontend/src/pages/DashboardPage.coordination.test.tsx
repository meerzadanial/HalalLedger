import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  reject: (reason: unknown) => void;
};

const deferred = <T,>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const entry: DeliveryEntry = {
  id: 'entry-1',
  userId: 'user-1',
  restaurantName: 'Atomic Restaurant',
  restaurantStatus: 'halal',
  fareAmount: 12,
  hasCashOrder: false,
  entryDate: new Date('2025-01-01T00:00:00.000Z'),
  timestamp: new Date('2025-01-01T01:00:00.000Z'),
  createdAt: new Date('2025-01-01T01:00:00.000Z'),
  updatedAt: new Date('2025-01-01T01:00:00.000Z'),
};
const page: DeliveryEntryPage = { entries: [entry], total: 1 };
const totals: IncomeTotals = {
  totalHalalIncome: 12,
  totalNonHalalIncome: 0,
  totalCashIncome: 0,
  totalDigitalIncome: 12,
};

const renderDashboard = () => render(
  <MemoryRouter>
    <DashboardPage />
  </MemoryRouter>,
);

describe('DashboardPage coordinated data loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('authToken', 'token');
  });

  it('waits for both requests and commits their snapshots atomically', async () => {
    const entriesRequest = deferred<DeliveryEntryPage>();
    const totalsRequest = deferred<IncomeTotals>();
    vi.mocked(deliveryEntriesApi.getAll).mockReturnValue(entriesRequest.promise);
    vi.mocked(analyticsApi.getTotals).mockReturnValue(totalsRequest.promise);

    renderDashboard();
    expect(screen.getByText('Loading...')).toBeInTheDocument();

    await act(async () => entriesRequest.resolve(page));
    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Atomic Restaurant')).not.toBeInTheDocument();

    await act(async () => totalsRequest.resolve(totals));
    expect(await screen.findByText('Atomic Restaurant')).toBeInTheDocument();
    expect(screen.getAllByText(/RM\s+12\.00/)).toHaveLength(3);

    const entriesSignal = vi.mocked(deliveryEntriesApi.getAll).mock.calls[0][1]?.signal;
    const totalsSignal = vi.mocked(analyticsApi.getTotals).mock.calls[0][1]?.signal;
    expect(entriesSignal).toBeInstanceOf(AbortSignal);
    expect(totalsSignal).toBe(entriesSignal);
  });

  it('waits for both settlements and exposes no partial result when either fails', async () => {
    const entriesRequest = deferred<DeliveryEntryPage>();
    const totalsRequest = deferred<IncomeTotals>();
    vi.mocked(deliveryEntriesApi.getAll).mockReturnValue(entriesRequest.promise);
    vi.mocked(analyticsApi.getTotals).mockReturnValue(totalsRequest.promise);

    renderDashboard();
    await act(async () => entriesRequest.reject(new Error('Entries unavailable')));
    expect(screen.getByText('Loading...')).toBeInTheDocument();

    await act(async () => totalsRequest.resolve(totals));
    expect(await screen.findByRole('alert')).toHaveTextContent('Entries unavailable');
    expect(screen.queryByText('Total Halal Income')).not.toBeInTheDocument();
    expect(screen.queryByText('Atomic Restaurant')).not.toBeInTheDocument();
  });

  it('aborts the owned coordinated request on unmount', () => {
    vi.mocked(deliveryEntriesApi.getAll).mockReturnValue(new Promise(() => {}));
    vi.mocked(analyticsApi.getTotals).mockReturnValue(new Promise(() => {}));

    const view = renderDashboard();
    const entriesSignal = vi.mocked(deliveryEntriesApi.getAll).mock.calls[0][1]?.signal;
    const totalsSignal = vi.mocked(analyticsApi.getTotals).mock.calls[0][1]?.signal;
    expect(entriesSignal?.aborted).toBe(false);
    expect(totalsSignal).toBe(entriesSignal);

    view.unmount();
    expect(entriesSignal?.aborted).toBe(true);
  });

  it('preserves unauthorized token clearing and redirect after both requests settle', async () => {
    const totalsRequest = deferred<IncomeTotals>();
    vi.mocked(deliveryEntriesApi.getAll).mockRejectedValue(new Error('Unauthorized'));
    vi.mocked(analyticsApi.getTotals).mockReturnValue(totalsRequest.promise);

    renderDashboard();
    await act(async () => Promise.resolve());
    expect(navigate).not.toHaveBeenCalled();

    await act(async () => totalsRequest.resolve(totals));
    expect(navigate).toHaveBeenCalledWith('/login');
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  it('fails closed on a reversed range, retains non-date filters, and reloads a correction at offset zero', async () => {
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue(page);
    vi.mocked(analyticsApi.getTotals).mockResolvedValue(totals);

    renderDashboard();
    expect(await screen.findByText('Atomic Restaurant')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2025-01-20' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2025-01-10' } });
    fireEvent.change(screen.getByLabelText('Restaurant Status'), { target: { value: 'halal' } });
    fireEvent.change(screen.getByLabelText('Payment Type'), { target: { value: 'cash' } });

    const requestCount = vi.mocked(deliveryEntriesApi.getAll).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Start date must be on or before end date.',
    );
    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(requestCount);
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(requestCount);
    expect(screen.queryByText('Total Halal Income')).not.toBeInTheDocument();
    expect(screen.queryByText('Atomic Restaurant')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recent Deliveries' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Restaurant Status')).toHaveValue('halal');
    expect(screen.getByLabelText('Payment Type')).toHaveValue('cash');

    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2025-01-21' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(
      {
        startDate: '2025-01-20',
        endDate: '2025-01-21',
        restaurantStatus: 'halal',
        paymentType: 'cash',
        limit: 10,
        offset: 0,
      },
      { signal: expect.any(AbortSignal) },
    ));
    expect(analyticsApi.getTotals).toHaveBeenLastCalledWith(
      {
        startDate: '2025-01-20',
        endDate: '2025-01-21',
        restaurantStatus: 'halal',
        paymentType: 'cash',
      },
      { signal: expect.any(AbortSignal) },
    );
    expect(await screen.findByText('Atomic Restaurant')).toBeInTheDocument();
  });

  it('preserves pagination offsets only for page navigation and resets them on apply and clear', async () => {
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue({ ...page, total: 25 });
    vi.mocked(analyticsApi.getTotals).mockResolvedValue(totals);

    renderDashboard();
    expect(await screen.findByText('Atomic Restaurant')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(
      { limit: 10, offset: 10 },
      { signal: expect.any(AbortSignal) },
    ));

    fireEvent.change(screen.getByLabelText('Restaurant Status'), { target: { value: 'halal' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));
    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(
      { restaurantStatus: 'halal', limit: 10, offset: 0 },
      { signal: expect.any(AbortSignal) },
    ));

    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(
      { restaurantStatus: 'halal', limit: 10, offset: 10 },
      { signal: expect.any(AbortSignal) },
    ));

    fireEvent.click(screen.getByRole('button', { name: 'Clear Filters' }));
    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(
      { limit: 10, offset: 0 },
      { signal: expect.any(AbortSignal) },
    ));
  });
});
