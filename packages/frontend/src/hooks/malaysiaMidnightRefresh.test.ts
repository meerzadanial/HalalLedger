import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createMalaysiaMidnightRefreshController,
  malaysiaDateAt,
  nextMalaysiaMidnightAfter,
  type MalaysiaMidnightDocument,
  type MalaysiaMidnightRefreshController,
} from './malaysiaMidnightRefresh';

const deferred = <T,>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

class TestVisibilityDocument implements MalaysiaMidnightDocument {
  visibilityState = 'visible';
  private readonly listeners = new Set<() => void>();

  addEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: 'visibilitychange', listener: () => void): void {
    this.listeners.delete(listener);
  }

  dispatchVisibilityChange(): void {
    this.listeners.forEach((listener) => listener());
  }
}

describe('Malaysia midnight totals refresh controller', () => {
  const controllers: MalaysiaMidnightRefreshController[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T15:59:59.000Z'));
  });

  afterEach(() => {
    controllers.forEach((controller) => controller.dispose());
    controllers.length = 0;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });


  const createController = (
    refreshTotals: () => Promise<void>,
    overrides: Partial<Parameters<typeof createMalaysiaMidnightRefreshController>[0]> = {},
  ) => {
    const controller = createMalaysiaMidnightRefreshController({
      refreshTotals,
      onRefreshError: vi.fn(),
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  };

  it('derives the Malaysian date and next midnight independently of host-local time', () => {
    expect(malaysiaDateAt(new Date('2025-01-01T15:59:59.999Z'))).toBe('2025-01-01');
    expect(malaysiaDateAt(new Date('2025-01-01T16:00:00.000Z'))).toBe('2025-01-02');
    expect(nextMalaysiaMidnightAfter(new Date('2025-01-01T15:59:59.999Z')).toISOString())
      .toBe('2025-01-01T16:00:00.000Z');
  });

  it('attempts immediately at Malaysian midnight and retries at most three times', async () => {
    const attemptTimes: number[] = [];
    const finalFailure = new Error('totals unavailable');
    const refreshTotals = vi.fn(async () => {
      attemptTimes.push(Date.now());
      throw finalFailure;
    });
    const onRefreshError = vi.fn();
    createController(refreshTotals, { onRefreshError });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshTotals).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(refreshTotals).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshTotals).toHaveBeenCalledTimes(4);
    expect(attemptTimes).toEqual([
      Date.parse('2025-01-01T16:00:00.000Z'),
      Date.parse('2025-01-01T16:00:30.000Z'),
      Date.parse('2025-01-01T16:01:00.000Z'),
      Date.parse('2025-01-01T16:01:30.000Z'),
    ]);
    expect(onRefreshError).toHaveBeenCalledTimes(1);
    expect(onRefreshError).toHaveBeenCalledWith(finalFailure);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshTotals).toHaveBeenCalledTimes(4);
  });

  it('stops retrying on success and clears a previous refresh error', async () => {
    const refreshTotals = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce(undefined);
    const onRefreshError = vi.fn();
    createController(refreshTotals, { onRefreshError });

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(refreshTotals).toHaveBeenCalledTimes(2);
    expect(onRefreshError).toHaveBeenCalledWith(null);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refreshTotals).toHaveBeenCalledTimes(2);
  });


  it('does not overlap an unresolved request even after more than 60 seconds', async () => {
    const pending = deferred<void>();
    const refreshTotals = vi.fn(() => pending.promise);
    createController(refreshTotals);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(refreshTotals).toHaveBeenCalledTimes(1);

    pending.resolve(undefined);
    await Promise.resolve();
    expect(refreshTotals).toHaveBeenCalledTimes(1);
  });

  it('catches up when visibility resumes after a suspended midnight timer', async () => {
    const visibilityDocument = new TestVisibilityDocument();
    const refreshTotals = vi.fn().mockResolvedValue(undefined);
    createController(refreshTotals, { document: visibilityDocument });

    vi.setSystemTime(new Date('2025-01-02T17:00:00.000Z'));
    visibilityDocument.dispatchVisibilityChange();
    await Promise.resolve();

    expect(refreshTotals).toHaveBeenCalledTimes(1);
  });

  it('stays inactive with explicit dates and reschedules after dates are cleared', async () => {
    const refreshTotals = vi.fn().mockResolvedValue(undefined);
    const controller = createController(refreshTotals, {
      scope: { startDate: '2024-12-01', endDate: '2024-12-31' },
    });

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(refreshTotals).not.toHaveBeenCalled();

    controller.update({ scope: {}, refreshTotals });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refreshTotals).toHaveBeenCalledTimes(1);
  });

  it('aborts and invalidates a pending generation on filter changes or disposal', async () => {
    const pending = deferred<void>();
    let signal: AbortSignal | undefined;
    const refreshTotals = vi.fn(({ signal: attemptSignal }) => {
      signal = attemptSignal;
      return pending.promise;
    });
    const onRefreshError = vi.fn();
    const controller = createMalaysiaMidnightRefreshController({
      refreshTotals,
      onRefreshError,
    });
    controllers.push(controller);

    await vi.advanceTimersByTimeAsync(1_000);
    controller.update({
      scope: { startDate: '2025-01-02', endDate: '2025-01-02' },
      refreshTotals,
    });
    expect(signal?.aborted).toBe(true);

    pending.reject(new Error('stale rejection'));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(refreshTotals).toHaveBeenCalledTimes(1);
    expect(onRefreshError).not.toHaveBeenCalled();

    controller.dispose();
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1_000);
    expect(refreshTotals).toHaveBeenCalledTimes(1);
  });
});