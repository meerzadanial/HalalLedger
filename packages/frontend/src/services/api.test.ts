import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DashboardApiError,
  analyticsApi,
  deliveryEntriesApi,
} from './api';

const jsonResponse = (body: unknown, status = 200): Response => new Response(
  JSON.stringify(body),
  { status, headers: { 'Content-Type': 'application/json' } },
);

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