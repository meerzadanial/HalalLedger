import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardApiError,
  ReportApiError,
  analyticsApi,
  deliveryEntriesApi,
  reportsApi,
  type CreateReportRequestInput,
  type ReportRequestDto,
} from './api';

const FIRST_CLIENT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_CLIENT_ID = '22222222-2222-4222-8222-222222222222';
const REQUEST_ID = '33333333-3333-4333-8333-333333333333';

const reportDto: ReportRequestDto = {
  id: REQUEST_ID,
  reportType: 'weekly',
  referenceDate: '2025-01-08',
  period: { startDate: '2025-01-06', endDate: '2025-01-12', inclusive: true },
  accountEmail: 'driver@example.com',
  status: 'pending',
  progressStage: 'data_retrieval',
  createdAt: '2025-01-08T10:00:00Z',
  providerAcceptedAt: null,
  sentAt: null,
  failure: null,
  canRetry: false,
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

describe('reportsApi', () => {
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >();

  beforeEach(() => {
    localStorage.setItem('authToken', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce(FIRST_CLIENT_ID)
        .mockReturnValueOnce(SECOND_CLIENT_ID),
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('creates and retries with distinct stable UUID bodies and no recipient override', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(reportDto, 202))
      .mockResolvedValueOnce(jsonResponse(reportDto, 202));
    const input = {
      reportType: 'weekly',
      referenceDate: '2025-01-08',
      accountEmail: 'attacker@example.com',
    } as unknown as CreateReportRequestInput;

    await reportsApi.create(input);
    await reportsApi.retry(REQUEST_ID);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const createOptions = fetchMock.mock.calls[0][1] as RequestInit;
    const retryOptions = fetchMock.mock.calls[1][1] as RequestInit;
    expect(JSON.parse(createOptions.body as string)).toEqual({
      reportType: 'weekly',
      referenceDate: '2025-01-08',
      clientRequestId: FIRST_CLIENT_ID,
    });
    expect(JSON.parse(retryOptions.body as string)).toEqual({
      clientRequestId: SECOND_CLIENT_ID,
    });
    expect(createOptions.method).toBe('POST');
    expect(retryOptions.method).toBe('POST');
  });

  it('does not generically retry a failed create request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 'provider_unavailable',
      stage: 'email_submission',
      message: 'Report email submission is temporarily unavailable.',
    }, 503));

    await expect(reportsApi.create({
      reportType: 'monthly',
      referenceDate: '2025-01-08',
    })).rejects.toMatchObject({ status: 503, code: 'provider_unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps structured report errors without inspecting message text', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 'future_reference_date',
      stage: 'unexpected',
      message: 'A safe localized message with arbitrary wording.',
      fieldErrors: {
        referenceDate: 'Future dates are not permitted.',
        ignoredField: 'must not cross the wire contract',
      },
      correlationId: FIRST_CLIENT_ID,
    }, 400));

    const error = await reportsApi.resolve('weekly', '2026-01-01').catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ReportApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'future_reference_date',
      stage: 'unexpected',
      message: 'A safe localized message with arbitrary wording.',
      fieldErrors: { referenceDate: 'Future dates are not permitted.' },
      correlationId: FIRST_CLIENT_ID,
    });
    expect((error as ReportApiError).fieldErrors).not.toHaveProperty('ignoredField');
  });

  it('retries transient GET polling failures and returns the recovered status', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse({
        code: 'unexpected_report_error',
        message: 'Temporary failure.',
      }, 503))
      .mockResolvedValueOnce(jsonResponse(reportDto));

    const pendingStatus = reportsApi.status(REQUEST_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(pendingStatus).resolves.toEqual(reportDto);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([, options]) => options?.method === 'GET')).toBe(true);
  });

  it('returns null for an empty active-request response', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(reportsApi.active()).resolves.toBeNull();
  });
});


describe('reportsApi task 7.4 transport guarantees', () => {
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >();

  beforeEach(() => {
    localStorage.setItem('authToken', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn()
        .mockReturnValueOnce(FIRST_CLIENT_ID)
        .mockReturnValueOnce(SECOND_CLIENT_ID),
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('uses one stable client ID per POST action and a new ID for the next user action', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(reportDto, 202))
      .mockResolvedValueOnce(jsonResponse({ ...reportDto, id: SECOND_CLIENT_ID }, 202));

    await reportsApi.create({ reportType: 'weekly', referenceDate: '2025-01-08' });
    await reportsApi.create({ reportType: 'weekly', referenceDate: '2025-01-08' });

    const firstBody = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1]?.body as string);
    expect(firstBody.clientRequestId).toBe(FIRST_CLIENT_ID);
    expect(secondBody.clientRequestId).toBe(SECOND_CLIENT_ID);
    expect(firstBody.clientRequestId).not.toBe(secondBody.clientRequestId);
    expect(crypto.randomUUID).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps typed conflict details including the owned active request', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 'report_in_progress',
      stage: 'email_submission',
      message: 'A report request is already in progress.',
      fieldErrors: { referenceDate: 'Retain the existing selection.' },
      activeRequest: reportDto,
      correlationId: FIRST_CLIENT_ID,
    }, 409));

    const error = await reportsApi.create({
      reportType: 'weekly',
      referenceDate: '2025-01-08',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ReportApiError);
    expect(error).toMatchObject({
      status: 409,
      code: 'report_in_progress',
      stage: 'email_submission',
      fieldErrors: { referenceDate: 'Retain the existing selection.' },
      activeRequest: reportDto,
      correlationId: FIRST_CLIENT_ID,
    });
  });

  it('retries a transient GET with the same URL and authorization request', async () => {
    vi.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('temporary network failure'))
      .mockResolvedValueOnce(jsonResponse(reportDto));

    const result = reportsApi.status(REQUEST_ID);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(result).resolves.toEqual(reportDto);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'GET',
      headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
    });
  });

  it('does not generically retry the explicit retry POST', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      code: 'unexpected_report_error',
      message: 'Temporary server failure.',
    }, 503));

    await expect(reportsApi.retry(REQUEST_ID)).rejects.toMatchObject({
      status: 503,
      code: 'unexpected_report_error',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]?.method).toBe('POST');
    expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
      clientRequestId: FIRST_CLIENT_ID,
    });
  });
});

describe('dashboard API contract', () => {
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >();

  beforeEach(() => {
    localStorage.setItem('authToken', 'test-token');
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('serializes canonical entry filters unchanged and preserves numeric zero', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [], total: 0 }));

    await deliveryEntriesApi.getAll({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      restaurantStatus: 'halal',
      paymentType: 'cash',
      limit: 10,
      offset: 0,
    });

    const url = new URL(fetchMock.mock.calls[0][0].toString());
    expect(url.pathname).toBe('/api/income-entries');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: '2025-01-01',
      endDate: '2025-01-31',
      restaurantStatus: 'halal',
      paymentType: 'cash',
      limit: '10',
      offset: '0',
    });
  });

  it('serializes analytics payment type and propagates the abort signal', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      totalHalalIncome: 0,
      totalNonHalalIncome: 0,
      totalCashIncome: 0,
      totalDigitalIncome: 0,
    }));
    const controller = new AbortController();

    await analyticsApi.getTotals({
      startDate: '2025-02-01',
      endDate: '2025-02-01',
      paymentType: 'digital',
    }, { signal: controller.signal });

    const [input, init] = fetchMock.mock.calls[0];
    const url = new URL(input.toString());
    expect(url.pathname).toBe('/api/analytics/totals');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      startDate: '2025-02-01',
      endDate: '2025-02-01',
      paymentType: 'digital',
    });
    expect(init?.signal).toBe(controller.signal);
  });

  it('propagates the abort signal for entry requests', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ entries: [], total: 0 }));
    const controller = new AbortController();

    await deliveryEntriesApi.getAll(undefined, { signal: controller.signal });

    expect(fetchMock.mock.calls[0][1]?.signal).toBe(controller.signal);
  });

  it('keeps only known validation details and does not expose arbitrary server content', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      error: 'Validation failed',
      details: [
        'Offset must be an integer between 0 and 2147483647',
        '<script>unsafe server detail</script>',
        { internal: 'database detail' },
      ],
    }, 400));

    const error = await deliveryEntriesApi.getAll({ offset: -1 }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(DashboardApiError);
    expect(error).toMatchObject({
      status: 400,
      message: 'Validation failed: Offset must be an integer between 0 and 2147483647',
      details: ['Offset must be an integer between 0 and 2147483647'],
    });
    expect((error as Error).message).not.toContain('unsafe server detail');
    expect(JSON.stringify(error)).not.toContain('database detail');
  });

  it('retains unauthorized error messages for existing redirect handling', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'Invalid token' }, 401));

    await expect(analyticsApi.getTotals()).rejects.toMatchObject({
      status: 401,
      message: 'Invalid token',
    });
  });
});