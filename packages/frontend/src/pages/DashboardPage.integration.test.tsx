import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthContext, type AuthContextValue } from '../contexts/AuthContext';
import type { DeliveryEntry, IncomeTotals } from '../types';
import {
  ReportApiError,
  analyticsApi,
  deliveryEntriesApi,
  reportsApi,
  type ReportFailureStage,
  type ReportRequestDto,
  type ResolveReportPeriodDto,
} from '../services/api';
import DashboardPage from './DashboardPage';

vi.mock('../services/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/api')>();
  return {
    ...actual,
    deliveryEntriesApi: { ...actual.deliveryEntriesApi, getAll: vi.fn(), delete: vi.fn() },
    analyticsApi: { ...actual.analyticsApi, getTotals: vi.fn() },
    reportsApi: {
      active: vi.fn(),
      resolve: vi.fn(),
      create: vi.fn(),
      status: vi.fn(),
      retry: vi.fn(),
    },
  };
});

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const resolvedPeriod: ResolveReportPeriodDto = {
  reportType: 'weekly',
  referenceDate: '2025-01-08',
  period: { startDate: '2025-01-06', endDate: '2025-01-12', inclusive: true },
  accountEmail: 'driver@example.com',
  timeZone: 'Asia/Kuala_Lumpur',
};

const reportFixture = (overrides: Partial<ReportRequestDto> = {}): ReportRequestDto => ({
  id: 'report-1',
  reportType: 'weekly',
  referenceDate: '2025-01-08',
  period: resolvedPeriod.period,
  accountEmail: 'driver@example.com',
  status: 'processing',
  progressStage: 'csv_generation',
  createdAt: '2025-01-08T10:00:00Z',
  providerAcceptedAt: null,
  sentAt: null,
  failure: null,
  canRetry: false,
  ...overrides,
});

const entries: DeliveryEntry[] = Array.from({ length: 10 }, (_, index) => ({
  id: `entry-${index + 1}`,
  userId: 'user-1',
  restaurantName: `Restaurant ${index + 1}`,
  restaurantStatus: index % 2 === 0 ? 'halal' : 'non-halal',
  fareAmount: 10 + index,
  hasCashOrder: index % 2 === 0,
  cashAmount: index % 2 === 0 ? 5 : undefined,
  entryDate: new Date(`2025-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
  timestamp: new Date(`2025-01-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
  createdAt: new Date(`2025-01-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
  updatedAt: new Date(`2025-01-${String(index + 1).padStart(2, '0')}T10:00:00.000Z`),
}));

const totals: IncomeTotals = {
  totalHalalIncome: 125,
  totalNonHalalIncome: 75,
  totalCashIncome: 25,
  totalDigitalIncome: 175,
};

const authValue: AuthContextValue = {
  user: { userId: 'user-1', email: 'driver@example.com' },
  isAuthenticated: true,
  isLoading: false,
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
  login: vi.fn(),
  register: vi.fn(),
  logout: vi.fn(),
  checkSession: vi.fn(),
  extendSession: vi.fn(),
};

const renderDashboard = () => render(
  <MemoryRouter>
    <AuthContext.Provider value={authValue}>
      <DashboardPage />
    </AuthContext.Provider>
  </MemoryRouter>,
);

const getReportStatus = () => within(
  screen.getByRole('region', { name: 'Bulk Print / Email CSV' }),
).getByRole('status');

const waitForDashboard = async () => {
  expect(await screen.findByRole('heading', { name: 'Recent Deliveries' })).toBeInTheDocument();
  expect(screen.getByText('Restaurant 1')).toBeInTheDocument();
};

const openAndResolveReport = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));
  fireEvent.change(screen.getByLabelText('Report reference date'), {
    target: { value: '2025-01-08' },
  });
  expect(await screen.findByText('2025-01-06 to 2025-01-12 (inclusive)')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeEnabled());
  return user;
};

describe('DashboardPage bulk report integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    vi.mocked(deliveryEntriesApi.getAll).mockResolvedValue({ entries, total: 25 });
    vi.mocked(deliveryEntriesApi.delete).mockResolvedValue(undefined);
    vi.mocked(analyticsApi.getTotals).mockResolvedValue(totals);
    vi.mocked(reportsApi.active).mockResolvedValue(null);
    vi.mocked(reportsApi.resolve).mockResolvedValue(resolvedPeriod);
    vi.mocked(reportsApi.create).mockResolvedValue(reportFixture());
    vi.mocked(reportsApi.status).mockResolvedValue(reportFixture());
    vi.mocked(reportsApi.retry).mockResolvedValue(reportFixture({ id: 'report-retry', status: 'pending', progressStage: 'data_retrieval' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('places the bulk CSV action immediately before New Entry in the Recent Deliveries header', async () => {
    renderDashboard();
    await waitForDashboard();

    const deliveries = screen.getByRole('region', { name: 'Recent Deliveries' });
    const header = deliveries.querySelector('.dashboard-entries__header');
    const bulkAction = within(deliveries).getByRole('button', { name: 'Bulk Print / Email CSV' });
    const newEntry = within(deliveries).getByRole('button', { name: 'New Entry' });

    expect(header).not.toBeNull();
    expect(header).toContainElement(bulkAction);
    expect(header).toContainElement(newEntry);
    expect(
      bulkAction.compareDocumentPosition(newEntry) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(bulkAction.closest('.dashboard-totals')).toBeNull();

    fireEvent.click(bulkAction);
    expect(within(deliveries).getByRole('region', { name: 'Bulk Print / Email CSV' })).toBeVisible();
    expect(newEntry).toBeVisible();
  });


  it('resolves and submits without changing filters, totals, entries, pagination, actions, or the legacy synchronous export route', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.mocked(reportsApi.create).mockResolvedValue(reportFixture({
      status: 'sent',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
      sentAt: '2025-01-08T10:00:04Z',
    }));
    renderDashboard();
    await waitForDashboard();

    fireEvent.change(screen.getByLabelText('Start Date'), { target: { value: '2025-01-01' } });
    fireEvent.change(screen.getByLabelText('End Date'), { target: { value: '2025-01-31' } });
    fireEvent.change(screen.getByLabelText('Restaurant Status'), { target: { value: 'halal' } });
    fireEvent.change(screen.getByLabelText('Payment Type'), { target: { value: 'cash' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply Filters' }));

    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(expect.objectContaining({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      restaurantStatus: 'halal',
      paymentType: 'cash',
      limit: 10,
      offset: 0,
    }), { signal: expect.any(AbortSignal) }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]);
    await waitFor(() => expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(expect.objectContaining({
      restaurantStatus: 'halal', paymentType: 'cash', limit: 10, offset: 10,
    }), { signal: expect.any(AbortSignal) }));
    expect(screen.getByText('Showing 11-20 of 25 entries')).toBeInTheDocument();

    const dashboardQueryCount = vi.mocked(deliveryEntriesApi.getAll).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));
    fireEvent.change(screen.getByLabelText('Report reference date'), { target: { value: '2025-01-08' } });
    await screen.findByText('2025-01-06 to 2025-01-12 (inclusive)');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Email CSV report' }));

    await waitFor(() => expect(getReportStatus()).toHaveTextContent('was sent to driver@example.com'));
    expect(reportsApi.resolve).toHaveBeenCalledWith('weekly', '2025-01-08');
    expect(reportsApi.create).toHaveBeenCalledWith({ reportType: 'weekly', referenceDate: '2025-01-08' });
    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(dashboardQueryCount);
    expect(analyticsApi.getTotals).toHaveBeenCalledTimes(dashboardQueryCount);
    expect(screen.getByLabelText('Start Date')).toHaveValue('2025-01-01');
    expect(screen.getByLabelText('End Date')).toHaveValue('2025-01-31');
    expect(screen.getByLabelText('Restaurant Status')).toHaveValue('halal');
    expect(screen.getByLabelText('Payment Type')).toHaveValue('cash');
    expect(screen.getByText(/RM\s+125\.00/)).toBeInTheDocument();
    expect(screen.getByText('Restaurant 1')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'New Entry' }));
    expect(navigate).toHaveBeenCalledWith('/entry/entry-1');
    expect(navigate).toHaveBeenCalledWith('/entry');

    fireEvent.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
    await waitFor(() => expect(deliveryEntriesApi.delete).toHaveBeenCalledWith('entry-1'));
    expect(deliveryEntriesApi.getAll).toHaveBeenLastCalledWith(expect.objectContaining({
      restaurantStatus: 'halal', paymentType: 'cash', limit: 10, offset: 10,
    }), { signal: expect.any(AbortSignal) });
    expect(fetchSpy.mock.calls.some(([url]) => String(url).includes('/api/income-entries/export'))).toBe(false);
  }, 15_000);


  it('restores active work after refresh, polls it, and shows success only after confirmation', async () => {
    vi.useFakeTimers();
    const processing = reportFixture({ status: 'processing', progressStage: 'snapshot' });
    const accepted = reportFixture({
      status: 'email_accepted',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
    });
    const sent = reportFixture({
      status: 'sent',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
      sentAt: '2025-01-08T10:00:04Z',
    });
    vi.mocked(reportsApi.active).mockResolvedValueOnce(processing);

    const firstRender = renderDashboard();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getReportStatus()).toHaveTextContent('Preparing the report data snapshot.');
    expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeDisabled();
    expect(screen.getByText('Another report cannot be submitted while this request is in progress.')).toBeInTheDocument();
    expect(reportsApi.create).not.toHaveBeenCalled();
    expect(screen.queryByText(/was sent to driver@example.com/)).not.toBeInTheDocument();
    firstRender.unmount();

    vi.mocked(reportsApi.active).mockResolvedValueOnce(accepted);
    vi.mocked(reportsApi.status).mockResolvedValueOnce(sent);
    renderDashboard();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getReportStatus()).toHaveTextContent('Waiting for delivery confirmation.');
    expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    expect(screen.getByText('Restaurant 1')).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(reportsApi.status).toHaveBeenCalledWith('report-1');
    expect(getReportStatus()).toHaveTextContent(
      'Your weekly CSV report was sent to driver@example.com for the inclusive period 2025-01-06 to 2025-01-12.',
    );
  });

  it.each([
    ['data_retrieval', 'Report data retrieval failed.'],
    ['snapshot', 'Report generation failed while preparing the data snapshot.'],
    ['csv_generation', 'CSV report generation failed.'],
    ['report_size', 'The CSV report exceeded the email attachment size limit.'],
    ['email_submission', 'Report email submission failed before delivery was confirmed.'],
    ['unexpected', 'The report failed because of an unexpected error.'],
  ] as const)('retries a %s failure while retaining dashboard and report state', async (stage, copy) => {
    const failed = reportFixture({
      status: 'failed',
      progressStage: stage === 'report_size' || stage === 'unexpected' ? 'csv_generation' : stage,
      failure: { code: `${stage}_failed`, stage: stage as ReportFailureStage, message: 'internal detail' },
      canRetry: true,
    });
    vi.mocked(reportsApi.active).mockResolvedValue(failed);
    const user = userEvent.setup();
    renderDashboard();
    await waitForDashboard();

    const dashboardQueryCount = vi.mocked(deliveryEntriesApi.getAll).mock.calls.length;
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(copy);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByLabelText('Report reference date')).toHaveValue('2025-01-08');
    expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    expect(screen.getByText('Restaurant 1')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry report' }));
    expect(reportsApi.retry).toHaveBeenCalledTimes(1);
    expect(reportsApi.retry).toHaveBeenCalledWith('report-1');
    expect(getReportStatus()).toHaveTextContent('Report request queued.');
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByLabelText('Report reference date')).toHaveValue('2025-01-08');
    expect(deliveryEntriesApi.getAll).toHaveBeenCalledTimes(dashboardQueryCount);
  });


  it('recovers from an authentication-required report check without losing dashboard state', async () => {
    vi.mocked(reportsApi.active).mockRejectedValueOnce(new ReportApiError({
      status: 401,
      code: 'authentication_required',
      message: 'Expired session detail',
    }));
    const firstRender = renderDashboard();
    await waitForDashboard();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));

    expect(await screen.findByText('Authentication is required to request a report.')).toBeInTheDocument();
    expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    expect(screen.getByText('Restaurant 1')).toBeInTheDocument();
    firstRender.unmount();

    vi.mocked(reportsApi.active).mockResolvedValueOnce(null);
    renderDashboard();
    await waitForDashboard();
    const user = await openAndResolveReport();
    expect(screen.queryByText('Authentication is required to request a report.')).not.toBeInTheDocument();
    expect(screen.getByText('Total Halal Income')).toBeInTheDocument();
    expect(screen.getByText('Restaurant 1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Email CSV report' }));
    expect(reportsApi.create).toHaveBeenCalledTimes(1);
  }, 15_000);
});
