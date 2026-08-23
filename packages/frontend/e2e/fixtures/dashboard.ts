import { test as base, expect, type Page, type Route } from '@playwright/test';

const ACCOUNT_EMAIL = 'driver@example.test';
const REFERENCE_DATE = '2025-01-15';

export interface ReportRequestFixture {
  id: string;
  reportType: 'weekly' | 'monthly';
  referenceDate: string;
  period: { startDate: string; endDate: string; inclusive: true };
  accountEmail: string;
  status: 'pending' | 'processing' | 'email_submitted' | 'email_accepted' | 'sent' | 'failed';
  progressStage: 'data_retrieval' | 'snapshot' | 'csv_generation' | 'email_submission' | 'delivery_wait';
  createdAt: string;
  providerAcceptedAt: string | null;
  sentAt: string | null;
  failure: { code: string; stage: 'csv_generation'; message: string } | null;
  canRetry: boolean;
}

interface DashboardMockState {
  createFails: boolean;
  currentRequest: ReportRequestFixture | null;
  statusQueue: ReportRequestFixture[];
}

export interface DashboardHarness {
  page: Page;
  failNextCreate(): void;
}

const period = { startDate: '2025-01-13', endDate: '2025-01-19', inclusive: true } as const;
const requestFixture = (
  status: ReportRequestFixture['status'],
  overrides: Partial<ReportRequestFixture> = {},
): ReportRequestFixture => ({
  id: '00000000-0000-4000-8000-000000000001',
  reportType: 'monthly',
  referenceDate: REFERENCE_DATE,
  period,
  accountEmail: ACCOUNT_EMAIL,
  status,
  progressStage: status === 'sent' ? 'delivery_wait' : 'csv_generation',
  createdAt: '2025-01-15T02:00:00Z',
  providerAcceptedAt: status === 'sent' ? '2025-01-15T02:00:02Z' : null,
  sentAt: status === 'sent' ? '2025-01-15T02:00:03Z' : null,
  failure: null,
  canRetry: false,
  ...overrides,
});

const dashboardEntries = [{
  id: 'entry-001',
  userId: 'user-001',
  restaurantName: 'Example Kitchen',
  restaurantStatus: 'halal',
  fareAmount: 12.5,
  hasCashOrder: true,
  cashAmount: 5,
  entryDate: '2025-01-15T00:00:00.000Z',
  timestamp: '2025-01-15T02:00:00.000Z',
  createdAt: '2025-01-15T02:00:00.000Z',
  updatedAt: '2025-01-15T02:00:00.000Z',
}];

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const installDashboardRoutes = async (page: Page, state: DashboardMockState) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const { pathname } = url;
    if (pathname === '/api/auth/session') {
      return json(route, {
        userId: 'user-001',
        email: ACCOUNT_EMAIL,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (pathname === '/api/income-entries' && request.method() === 'GET') {
      return json(route, { entries: dashboardEntries, total: dashboardEntries.length });
    }
    if (pathname === '/api/analytics/totals') {
      return json(route, {
        totalHalalIncome: 17.5,
        totalNonHalalIncome: 0,
        totalCashIncome: 5,
        totalDigitalIncome: 12.5,
      });
    }
    if (pathname === '/api/report-requests/active') {
      return state.currentRequest === null
        ? route.fulfill({ status: 204 })
        : json(route, state.currentRequest);
    }
    if (pathname === '/api/report-periods/resolve') {
      const reportType = url.searchParams.get('reportType') === 'monthly' ? 'monthly' : 'weekly';
      return json(route, {
        reportType,
        referenceDate: url.searchParams.get('referenceDate') ?? REFERENCE_DATE,
        period,
        accountEmail: ACCOUNT_EMAIL,
        timeZone: 'Asia/Kuala_Lumpur',
      });
    }
    if (pathname === '/api/report-requests' && request.method() === 'POST') {
      state.currentRequest = state.createFails
        ? requestFixture('failed', {
            failure: { code: 'csv_generation_failed', stage: 'csv_generation', message: 'CSV generation failed.' },
            canRetry: true,
          })
        : requestFixture('processing');
      return json(route, state.currentRequest, 202);
    }
    if (/^\/api\/report-requests\/[^/]+\/retries$/.test(pathname) && request.method() === 'POST') {
      state.currentRequest = requestFixture('processing', { id: '00000000-0000-4000-8000-000000000002' });
      state.statusQueue = [requestFixture('sent', { id: state.currentRequest.id })];
      return json(route, state.currentRequest, 202);
    }
    if (/^\/api\/report-requests\/[^/]+$/.test(pathname) && request.method() === 'GET') {
      state.currentRequest = state.statusQueue.shift() ?? state.currentRequest ?? requestFixture('sent');
      return json(route, state.currentRequest);
    }
    if (pathname === '/api/auth/logout') return route.fulfill({ status: 204 });

    return json(route, { error: `Unhandled deterministic test route: ${request.method()} ${pathname}` }, 418);
  });
};

export const test = base.extend<{ dashboard: DashboardHarness }>({
  dashboard: async ({ page }, use) => {
    const state: DashboardMockState = {
      createFails: false,
      currentRequest: null,
      statusQueue: [requestFixture('sent')],
    };
    await page.addInitScript(() => localStorage.setItem('authToken', 'local-browser-fixture-token'));
    await installDashboardRoutes(page, state);
    await use({
      page,
      failNextCreate: () => {
        state.createFails = true;
        state.currentRequest = null;
        state.statusQueue = [requestFixture('sent')];
      },
    });
  },
});

export { expect, ACCOUNT_EMAIL, REFERENCE_DATE };
