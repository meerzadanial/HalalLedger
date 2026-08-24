import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BulkReportPanel, { type BulkReportApi } from './BulkReportPanel';
import {
  ReportApiError,
  type ReportRequestDto,
  type ResolveReportPeriodDto,
} from '../services/api';

const resolvedPeriod: ResolveReportPeriodDto = {
  reportType: 'weekly',
  referenceDate: '2025-01-08',
  period: { startDate: '2025-01-06', endDate: '2025-01-12', inclusive: true },
  accountEmail: 'driver@example.com',
  timeZone: 'Asia/Kuala_Lumpur',
};

const requestFixture = (overrides: Partial<ReportRequestDto> = {}): ReportRequestDto => ({
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

const createApi = (overrides: Partial<BulkReportApi> = {}): BulkReportApi => ({
  active: vi.fn().mockResolvedValue(null),
  resolve: vi.fn().mockResolvedValue(resolvedPeriod),
  create: vi.fn().mockResolvedValue(requestFixture()),
  status: vi.fn().mockResolvedValue(requestFixture()),
  retry: vi.fn().mockResolvedValue(requestFixture()),
  ...overrides,
});

describe('BulkReportPanel', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expands from the exact action label into two keyboard-native report choices and moves focus only for that expansion', async () => {
    const user = userEvent.setup();
    render(<BulkReportPanel accountEmail="driver@example.com" api={createApi()} />);

    const action = screen.getByRole('button', { name: 'Bulk Print / Email CSV' });
    expect(action).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryAllByRole('radio')).toHaveLength(0);

    await user.click(action);

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeInTheDocument();
    expect(screen.getByLabelText('Report reference date')).toHaveAttribute('type', 'date');
    expect(screen.getByText('driver@example.com')).toBeInTheDocument();
  });

  it('keeps the last valid inclusive period visible when a later date is rejected and prevents submission', async () => {
    const futureError = new ReportApiError({
      status: 400,
      code: 'future_reference_date',
      message: 'Future dates are not permitted.',
      fieldErrors: { referenceDate: 'Future dates are not permitted.' },
    });
    const api = createApi({
      resolve: vi.fn()
        .mockResolvedValueOnce(resolvedPeriod)
        .mockRejectedValueOnce(futureError),
    });
    const user = userEvent.setup();
    render(<BulkReportPanel api={api} />);

    await user.click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    fireEvent.change(screen.getByLabelText('Report reference date'), { target: { value: '2025-01-08' } });

    expect(await screen.findByText('2025-01-06 to 2025-01-12 (inclusive)')).toBeInTheDocument();
    expect(screen.getByText('Report period')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Report reference date'), { target: { value: '2099-01-01' } });

    expect(await screen.findByText('Future dates are not permitted.')).toBeInTheDocument();
    expect(screen.getByText('2025-01-06 to 2025-01-12 (inclusive)')).toBeInTheDocument();
    expect(screen.getByText('Last valid report period')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('prevents duplicate submissions while one create request is pending', async () => {
    let finishCreate: ((request: ReportRequestDto) => void) | undefined;
    const create = vi.fn(() => new Promise<ReportRequestDto>((resolve) => { finishCreate = resolve; }));
    const api = createApi({ create });
    const user = userEvent.setup();
    render(<BulkReportPanel api={api} />);

    await user.click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    fireEvent.change(screen.getByLabelText('Report reference date'), { target: { value: '2025-01-08' } });
    const submit = await screen.findByRole('button', { name: 'Email CSV report' });
    await waitFor(() => expect(submit).toBeEnabled());

    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(create).toHaveBeenCalledTimes(1);
    expect(submit).toBeDisabled();

    await act(async () => { finishCreate?.(requestFixture()); });
    expect(await screen.findByRole('status')).toHaveTextContent('Generating the CSV report.');
  });

  it('restores an active request, polls after two seconds, and announces success only after SENT', async () => {
    vi.useFakeTimers();
    const accepted = requestFixture({
      status: 'email_accepted',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
    });
    const sent = requestFixture({
      status: 'sent',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
      sentAt: '2025-01-08T10:00:04Z',
    });
    const api = createApi({
      active: vi.fn().mockResolvedValue(accepted),
      status: vi.fn().mockResolvedValue(sent),
    });

    render(<BulkReportPanel api={api} />);
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByRole('status')).toHaveTextContent('Waiting for delivery confirmation');
    expect(screen.queryByText(/Report sent to/)).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Weekly' })).not.toHaveFocus();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.status).toHaveBeenCalledWith('report-1');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Your weekly CSV report was sent to driver@example.com for the inclusive period 2025-01-06 to 2025-01-12.',
    );
  });

  it('shows a stage-specific capped failure with one retry control and retains the failed selection', async () => {
    const failed = requestFixture({
      status: 'failed',
      progressStage: 'email_submission',
      failure: {
        code: 'provider_rejected',
        stage: 'email_submission',
        message: 'The report email could not be delivered.',
      },
      canRetry: true,
    });
    const retried = requestFixture({ id: 'report-2', status: 'pending', progressStage: 'data_retrieval' });
    const api = createApi({
      create: vi.fn().mockResolvedValue(failed),
      retry: vi.fn().mockResolvedValue(retried),
    });
    const user = userEvent.setup();
    render(<BulkReportPanel api={api} />);

    await user.click(screen.getByRole('button', { name: 'Bulk Print / Email CSV' }));
    await user.click(screen.getByRole('radio', { name: 'Weekly' }));
    fireEvent.change(screen.getByLabelText('Report reference date'), { target: { value: '2025-01-08' } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeEnabled());
    await user.click(screen.getByRole('button', { name: 'Email CSV report' }));

    const failureText = await screen.findByText(/Report email submission failed before delivery was confirmed\./);
    const alert = failureText.closest('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert).toHaveTextContent('The report was not sent to driver@example.com');
    expect(alert?.textContent?.length).toBeLessThanOrEqual(500);
    expect(screen.getAllByRole('button', { name: 'Retry report' })).toHaveLength(1);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeDisabled();
    expect(screen.getByLabelText('Report reference date')).toHaveValue('2025-01-08');

    await user.click(screen.getByRole('button', { name: 'Retry report' }));
    expect(api.retry).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('status')).toHaveTextContent('Report request queued.');
  });
});

describe('BulkReportPanel build-mode availability', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the production action visible but natively disabled, collapsed, grey, and inert', async () => {
    vi.stubEnv('PROD', true);
    const api = createApi();
    const user = userEvent.setup();

    render(<BulkReportPanel accountEmail="driver@example.com" api={api} />);

    const action = screen.getByRole('button', { name: 'Bulk Print / Email CSV' });
    expect(action.tagName).toBe('BUTTON');
    expect(action).toBeVisible();
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-expanded', 'false');
    expect(action).toHaveClass('border-gray-300', 'bg-gray-100', 'text-gray-500', 'cursor-not-allowed');
    expect(action.className).not.toContain('indigo');
    expect(action.className).not.toContain('hover:');
    expect(screen.queryByRole('region', { name: 'Bulk Print / Email CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Report reference date')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email CSV report' })).not.toBeInTheDocument();

    await waitFor(() => expect(api.active).toHaveBeenCalledTimes(1));
    await user.click(action);
    fireEvent.keyDown(action, { key: 'Enter', code: 'Enter' });
    fireEvent.keyUp(action, { key: 'Enter', code: 'Enter' });
    fireEvent.keyDown(action, { key: ' ', code: 'Space' });
    fireEvent.keyUp(action, { key: ' ', code: 'Space' });

    expect(action).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Bulk Print / Email CSV' })).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Report reference date')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email CSV report' })).not.toBeInTheDocument();
    expect(api.active).toHaveBeenCalledTimes(1);
    expect(api.resolve).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    expect(api.status).not.toHaveBeenCalled();
    expect(api.retry).not.toHaveBeenCalled();
  });

  it('preserves the enabled indigo action and unchanged panel expansion outside production', async () => {
    vi.stubEnv('PROD', false);
    const api = createApi();
    const user = userEvent.setup();

    render(<BulkReportPanel accountEmail="driver@example.com" api={api} />);

    const action = screen.getByRole('button', { name: 'Bulk Print / Email CSV' });
    expect(action).toBeEnabled();
    expect(action).toHaveAttribute('aria-expanded', 'false');
    expect(action).toHaveClass('border-indigo-600', 'text-indigo-700', 'hover:bg-indigo-50');
    expect(action.className).not.toContain('gray');

    await user.click(action);

    expect(action).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('region', { name: 'Bulk Print / Email CSV' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveFocus();
    expect(screen.getByRole('radio', { name: 'Monthly' })).toBeInTheDocument();
    expect(screen.getByLabelText('Report reference date')).toHaveAttribute('type', 'date');
    expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeInTheDocument();
  });
});

describe('BulkReportPanel task 7.4 accessibility and lifecycle coverage', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('supports a keyboard-only labeled flow, exposes exactly two choices, and never makes the recipient editable', async () => {
    const user = userEvent.setup();
    render(<BulkReportPanel accountEmail="driver@example.com" api={createApi()} />);

    await user.tab();
    const action = screen.getByRole('button', { name: 'Bulk Print / Email CSV' });
    expect(action).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getAllByRole('radio')).toHaveLength(2);
    const weekly = screen.getByRole('radio', { name: 'Weekly' });
    const monthly = screen.getByRole('radio', { name: 'Monthly' });
    expect(weekly).toHaveFocus();
    expect(weekly).toBeChecked();

    await user.keyboard('{ArrowRight}');
    expect(monthly).toHaveFocus();
    expect(monthly).toBeChecked();
    expect(screen.getByLabelText('Report reference date')).toHaveAttribute('type', 'date');
    expect(screen.getByText('driver@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /report recipient/i })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('driver@example.com')).not.toBeInTheDocument();

    await user.tab({ shift: true });
    expect(action).toHaveFocus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');
    expect(action).toHaveFocus();
    expect(weekly).not.toHaveFocus();
  });

  it('preserves the prior inclusive period after keyboard entry of an invalid future date', async () => {
    const api = createApi({
      resolve: vi.fn()
        .mockResolvedValueOnce(resolvedPeriod)
        .mockRejectedValueOnce(new ReportApiError({
          status: 400,
          code: 'future_reference_date',
          message: 'Server wording is not used for classification.',
        })),
    });
    const user = userEvent.setup();
    render(<BulkReportPanel api={api} />);

    await user.tab();
    await user.keyboard('{Enter}');
    const date = screen.getByLabelText('Report reference date');
    await user.type(date, '2025-01-08');
    expect(await screen.findByText('2025-01-06 to 2025-01-12 (inclusive)')).toBeInTheDocument();

    await user.clear(date);
    await user.type(date, '2099-01-01');
    expect(await screen.findByRole('alert', { name: '' })).toHaveTextContent('Future dates are not permitted.');
    expect(screen.getByText('Last valid report period')).toBeInTheDocument();
    expect(screen.getByText('2025-01-06 to 2025-01-12 (inclusive)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Email CSV report' })).toBeDisabled();
    expect(api.create).not.toHaveBeenCalled();
  });

  it('uses two-second polling, backs off to five seconds after 30 seconds, and clears polling on unmount', async () => {
    vi.useFakeTimers();
    const processing = requestFixture({ status: 'processing', progressStage: 'snapshot' });
    const api = createApi({
      active: vi.fn().mockResolvedValue(processing),
      status: vi.fn().mockResolvedValue(processing),
    });
    const { unmount } = render(<BulkReportPanel api={api} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    for (let poll = 0; poll < 15; poll += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_000);
      });
    }
    expect(api.status).toHaveBeenCalledTimes(15);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(api.status).toHaveBeenCalledTimes(15);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(api.status).toHaveBeenCalledTimes(16);

    unmount();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.status).toHaveBeenCalledTimes(16);
  });

  it('restores active work, announces status changes, and never steals focus for status updates', async () => {
    vi.useFakeTimers();
    let restore: ((request: ReportRequestDto) => void) | undefined;
    const accepted = requestFixture({
      status: 'email_accepted',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
    });
    const sent = requestFixture({
      status: 'sent',
      progressStage: 'delivery_wait',
      providerAcceptedAt: '2025-01-08T10:00:02Z',
      sentAt: '2025-01-08T10:00:04Z',
    });
    const api = createApi({
      active: vi.fn(() => new Promise<ReportRequestDto>((resolve) => { restore = resolve; })),
      status: vi.fn().mockResolvedValue(sent),
    });
    render(<BulkReportPanel api={api} />);

    const action = screen.getByRole('button', { name: 'Bulk Print / Email CSV' });
    action.focus();
    expect(action).toHaveFocus();
    await act(async () => { restore?.(accepted); });

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveAttribute('aria-atomic', 'true');
    expect(status).toHaveTextContent('Waiting for delivery confirmation.');
    expect(action).toHaveFocus();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(status).toHaveTextContent('Your weekly CSV report was sent to driver@example.com');
    expect(action).toHaveFocus();
  });

  it.each([
    ['data_retrieval', 'Report data retrieval failed.'],
    ['snapshot', 'Report generation failed while preparing the data snapshot.'],
    ['csv_generation', 'CSV report generation failed.'],
    ['report_size', 'The CSV report exceeded the email attachment size limit.'],
    ['email_submission', 'Report email submission failed before delivery was confirmed.'],
    ['unexpected', 'The report failed because of an unexpected error.'],
  ] as const)('uses safe %s failure-stage copy instead of backend details', async (stage, safeCopy) => {
    const failed = requestFixture({
      status: 'failed',
      failure: {
        code: `failed_${stage}`,
        stage,
        message: 'raw-provider-secret stack trace must never be presented',
      },
      canRetry: true,
    });
    render(<BulkReportPanel api={createApi({ active: vi.fn().mockResolvedValue(failed) })} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('aria-atomic', 'true');
    expect(alert).toHaveTextContent(safeCopy);
    expect(alert).toHaveTextContent('The report was not sent to driver@example.com');
    expect(alert).not.toHaveTextContent('raw-provider-secret');
    expect(alert.querySelector('p')?.textContent?.length).toBeLessThanOrEqual(500);
    expect(screen.getAllByRole('button', { name: 'Retry report' })).toHaveLength(1);
  });

  it('caps a live outcome announcement at 500 characters', async () => {
    const longRecipient = `${'recipient'.repeat(55)}@example.com`;
    const sent = requestFixture({
      accountEmail: longRecipient,
      status: 'sent',
      progressStage: 'delivery_wait',
      sentAt: '2025-01-08T10:00:04Z',
    });
    render(<BulkReportPanel api={createApi({ active: vi.fn().mockResolvedValue(sent) })} />);

    const status = await screen.findByRole('status');
    expect(status.textContent?.length).toBeLessThanOrEqual(500);
    expect(status).toHaveTextContent('Your weekly CSV report was sent to');
    expect(status.textContent).toMatch(/…$/);
  });

  it('allows one keyboard retry while retaining the failed report selection', async () => {
    let finishRetry: ((request: ReportRequestDto) => void) | undefined;
    const failed = requestFixture({
      status: 'failed',
      failure: { code: 'csv_failed', stage: 'csv_generation', message: 'Safe failure.' },
      canRetry: true,
    });
    const retry = vi.fn(() => new Promise<ReportRequestDto>((resolve) => { finishRetry = resolve; }));
    const api = createApi({
      active: vi.fn().mockResolvedValue(failed),
      retry,
    });
    const user = userEvent.setup();
    render(<BulkReportPanel api={api} />);

    await screen.findByRole('button', { name: 'Retry report' });
    await user.tab();
    await user.tab();
    const retryButton = screen.getByRole('button', { name: 'Retry report' });
    expect(retryButton).toHaveFocus();
    await user.keyboard('{Enter}{Enter}');

    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByLabelText('Report reference date')).toHaveValue('2025-01-08');
    expect(retryButton).toBeDisabled();

    await act(async () => { finishRetry?.(requestFixture({ id: 'report-2', status: 'pending' })); });
    expect(screen.getByRole('radio', { name: 'Weekly' })).toBeChecked();
    expect(screen.getByLabelText('Report reference date')).toHaveValue('2025-01-08');
  });
});