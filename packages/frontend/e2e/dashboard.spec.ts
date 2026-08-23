import AxeBuilder from '@axe-core/playwright';
import { test, expect, REFERENCE_DATE } from './fixtures/dashboard';
import type { Locator, Page } from '@playwright/test';

const widths = [320, 767, 768, 1024, 1440, 2560] as const;
const desktopWidths = widths.filter((width) => width >= 768);

const openResolvedPanel = async (page: Page) => {
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Bulk Print / Email CSV' }).click();
  await page.getByLabel('Report reference date').fill(REFERENCE_DATE);
  await expect(page.getByText('2025-01-13 to 2025-01-19 (inclusive)')).toBeVisible();
};

const expectNoHorizontalOverflow = async (page: Page) => {
  const geometry = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(geometry.document, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.viewport);
};

const expectControlsWithinViewport = async (page: Page) => {
  const controls = page.locator('.bulk-report-panel button:visible, .bulk-report-panel input:visible');
  const count = await controls.count();
  expect(count).toBeGreaterThanOrEqual(4);
  for (let index = 0; index < count; index += 1) {
    const box = await controls.nth(index).boundingBox();
    expect(box, `report control ${index} has no box`).not.toBeNull();
    expect(box!.x, `report control ${index} starts outside viewport`).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, `report control ${index} ends outside viewport`).toBeLessThanOrEqual(
      await page.evaluate(() => window.innerWidth),
    );
  }
};
const expectHeaderActionOrder = async (page: Page) => {
  const header = page.locator('.dashboard-entries__header');
  const bulkAction = header.getByRole('button', { name: 'Bulk Print / Email CSV' });
  const newEntry = header.getByRole('button', { name: 'New Entry' });

  await expect(bulkAction).toBeVisible();
  await expect(newEntry).toBeVisible();
  const directButtonNames = await header.locator(':scope > button').evaluateAll((buttons) =>
    buttons.map((button) => button.textContent?.replace(/[+−]/g, '').trim()),
  );
  expect(directButtonNames).toEqual(['Bulk Print / Email CSV', 'New Entry']);
};

const expectMinimumTarget = async (locator: Locator, name: string) => {
  const box = await locator.boundingBox();
  expect(box, `${name} has no activation box`).not.toBeNull();
  expect(box!.width, `${name} width`).toBeGreaterThanOrEqual(44);
  expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(44);
};

const tabTo = async (page: Page, locator: Locator, maximumTabs = 6) => {
  for (let tab = 0; tab < maximumTabs; tab += 1) {
    if (await locator.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  await expect(locator).toBeFocused();
};

const expectUnobscured = async (locator: Locator, name: string) => {
  await locator.scrollIntoViewIfNeeded();
  await expect(locator, `${name} is not visible`).toBeVisible();
  const unobscured = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const topElement = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return topElement !== null && (element === topElement || element.contains(topElement));
  });
  expect(unobscured, `${name} is obscured`).toBe(true);
};

test.describe('bulk report dashboard accessibility and responsive layout', () => {
  test('keeps report controls and delivery header actions usable from 320 through 2560 CSS pixels', async ({ dashboard }) => {
    for (const width of widths) {
      await dashboard.page.setViewportSize({ width, height: 900 });
      await openResolvedPanel(dashboard.page);
      await expectHeaderActionOrder(dashboard.page);
      await expectNoHorizontalOverflow(dashboard.page);
      await expectControlsWithinViewport(dashboard.page);

      if (width <= 767) {
        await expectMinimumTarget(
          dashboard.page.getByRole('button', { name: 'Bulk Print / Email CSV' }),
          `${width}px bulk report action`,
        );
        await expectMinimumTarget(
          dashboard.page.getByRole('button', { name: 'New Entry' }),
          `${width}px New Entry action`,
        );
        await expectMinimumTarget(
          dashboard.page.getByRole('button', { name: 'Email CSV report' }),
          `${width}px submit action`,
        );
      }
    }
  });
  test('supports keyboard-only operation, live announcements, and an axe scan', async ({ dashboard }) => {
    const { page } = dashboard;
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto('/dashboard');
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Logout' })).toBeFocused();
    const action = page.getByRole('button', { name: 'Bulk Print / Email CSV' });
    await tabTo(page, action, 24);
    await page.keyboard.press('Enter');

    const weekly = page.getByRole('radio', { name: 'Weekly' });
    const monthly = page.getByRole('radio', { name: 'Monthly' });
    await expect(weekly).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(monthly).toBeChecked();
    await page.keyboard.press('Tab');
    const date = page.getByLabel('Report reference date');
    await expect(date).toBeFocused();
    await date.fill(REFERENCE_DATE);
    await expect(page.getByText('2025-01-13 to 2025-01-19 (inclusive)')).toBeVisible();

    const submit = page.getByRole('button', { name: 'Email CSV report' });
    // Chromium's native date editor may consume Tab for internal segments before
    // focus leaves the input, so follow the real keyboard order rather than
    // assuming a single Tab reaches the next control.
    await tabTo(page, submit);
    await page.keyboard.press('Enter');
    const status = page
      .getByRole('region', { name: 'Bulk Print / Email CSV' })
      .getByRole('status');
    await expect(status).toHaveAttribute('aria-live', 'polite');
    await expect(status).toHaveAttribute('aria-atomic', 'true');
    await expect(status).toContainText('Report in progress');
    await expect(status).toContainText('sent to driver@example.test', { timeout: 5_000 });

    // The terminal update disables the submitted form controls. Keyboard focus
    // can still leave the report panel and continue into the dashboard filters.
    await tabTo(page, page.getByLabel('Start Date'));

    const accessibility = await new AxeBuilder({ page })
      .include('.bulk-report-panel')
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    expect(accessibility.violations).toEqual([]);
  });
  test('keeps desktop totals, filters, entries, and New Entry visible and operable', async ({ dashboard }) => {
    for (const width of desktopWidths) {
      const { page } = dashboard;
      await page.setViewportSize({ width, height: 900 });
      await openResolvedPanel(page);
      await expectHeaderActionOrder(page);
      await expectNoHorizontalOverflow(page);

      const totals = page.locator('.dashboard-totals');
      const filters = page.getByRole('complementary', { name: 'Filter delivery entries' });
      const entries = page.getByRole('region', { name: 'Recent Deliveries' });
      const applyFilters = page.getByRole('button', { name: 'Apply Filters' });
      const newEntry = page.getByRole('button', { name: 'New Entry' });

      await expectUnobscured(totals, `${width}px income totals`);
      await expectUnobscured(filters, `${width}px dashboard filters`);
      await expectUnobscured(entries, `${width}px delivery entries`);
      await expectUnobscured(newEntry, `${width}px New Entry action`);
      await applyFilters.click({ trial: true });
      await newEntry.click({ trial: true });
    }
  });

  test('provides 44px mobile retry targets and announces retry progress', async ({ dashboard }) => {
    for (const width of [320, 767] as const) {
      dashboard.failNextCreate();
      const { page } = dashboard;
      await page.setViewportSize({ width, height: 900 });
      await openResolvedPanel(page);
      await page.getByRole('button', { name: 'Email CSV report' }).click();

      const alert = page.getByRole('alert').filter({ hasText: 'CSV report generation failed' });
      const retry = page.getByRole('button', { name: 'Retry report' });
      await expect(alert).toBeVisible();
      await expect(alert).toHaveAttribute('aria-atomic', 'true');
      await expectMinimumTarget(retry, `${width}px retry action`);
      await expectControlsWithinViewport(page);
      await expectNoHorizontalOverflow(page);

      await tabTo(page, retry);
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('region', { name: 'Bulk Print / Email CSV' }).getByRole('status'),
      ).toContainText('Report in progress');
      await expect(page.getByLabel('Monthly')).toBeChecked();
      await expect(page.getByLabel('Report reference date')).toHaveValue(REFERENCE_DATE);
    }
  });
});
