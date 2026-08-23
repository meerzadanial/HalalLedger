const MALAYSIA_TIME_ZONE = 'Asia/Kuala_Lumpur';
const MALAYSIA_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;
const RETRY_DELAY_MS = 30_000;
const MAX_RETRIES = 3;

const malaysiaDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: MALAYSIA_TIME_ZONE,
  calendar: 'gregory',
  numberingSystem: 'latn',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

interface MalaysiaDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export interface MalaysiaMidnightFilterScope {
  readonly startDate?: string;
  readonly endDate?: string;
}

export interface MalaysiaRefreshAttempt {
  readonly signal: AbortSignal;
}

export type MalaysiaTotalsRefresh = (attempt: MalaysiaRefreshAttempt) => Promise<void>;
export type MalaysiaRefreshErrorHandler = (error: unknown | null) => void;
export type MalaysiaTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export interface MalaysiaMidnightDocument {
  readonly visibilityState?: string;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange', listener: () => void): void;
}

export interface MalaysiaMidnightControllerOptions {
  readonly scope?: MalaysiaMidnightFilterScope;
  readonly refreshTotals: MalaysiaTotalsRefresh;
  readonly onRefreshError: MalaysiaRefreshErrorHandler;
  readonly now?: () => Date;
  readonly setTimeout?: (callback: () => void, delayMs: number) => MalaysiaTimerHandle;
  readonly clearTimeout?: (handle: MalaysiaTimerHandle) => void;
  readonly document?: MalaysiaMidnightDocument;
}

export interface MalaysiaMidnightControllerUpdate {
  readonly scope: MalaysiaMidnightFilterScope;
  readonly refreshTotals: MalaysiaTotalsRefresh;
}

export interface MalaysiaMidnightRefreshController {
  update(update: MalaysiaMidnightControllerUpdate): void;
  checkNow(): void;
  dispose(): void;
}

const malaysiaDatePartsAt = (instant: Date): MalaysiaDateParts => {
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid instant');

  const values: Partial<Record<'year' | 'month' | 'day', number>> = {};
  for (const part of malaysiaDateFormatter.formatToParts(instant)) {
    if (part.type === 'year' || part.type === 'month' || part.type === 'day') {
      values[part.type] = Number(part.value);
    }
  }

  if (values.year === undefined || values.month === undefined || values.day === undefined) {
    throw new Error('Unable to determine the Malaysian calendar date');
  }
  return { year: values.year, month: values.month, day: values.day };
};

export const malaysiaDateAt = (instant: Date): string => {
  const { year, month, day } = malaysiaDatePartsAt(instant);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

export const nextMalaysiaMidnightAfter = (instant: Date): Date => {
  const { year, month, day } = malaysiaDatePartsAt(instant);
  const nextLocalMidnightAsUtc = new Date(0);
  nextLocalMidnightAsUtc.setUTCHours(0, 0, 0, 0);
  nextLocalMidnightAsUtc.setUTCFullYear(year, month - 1, day + 1);
  return new Date(nextLocalMidnightAsUtc.getTime() - MALAYSIA_UTC_OFFSET_MS);
};

export const hasExplicitDateBoundary = (scope: MalaysiaMidnightFilterScope): boolean =>
  Boolean(scope.startDate || scope.endDate);

export const createMalaysiaMidnightRefreshController = (
  options: MalaysiaMidnightControllerOptions,
): MalaysiaMidnightRefreshController => {
  const now = options.now ?? (() => new Date());
  const scheduleTimeout = options.setTimeout ?? ((callback, delayMs) =>
    globalThis.setTimeout(callback, delayMs));
  const cancelTimeout = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle));
  const visibilityDocument = options.document
    ?? (typeof document === 'undefined' ? undefined : document);

  let scope = options.scope ?? {};
  let refreshTotals = options.refreshTotals;
  let generation = 0;
  let observedDate = '';
  let active = false;
  let disposed = false;
  let visibilitySubscribed = false;
  let inFlight = false;
  let catchUpAfterPending = false;
  let midnightTimer: MalaysiaTimerHandle | null = null;
  let retryTimer: MalaysiaTimerHandle | null = null;
  let attemptController: AbortController | null = null;

  const clearTimer = (timer: MalaysiaTimerHandle | null): void => {
    if (timer !== null) cancelTimeout(timer);
  };

  const cancelGeneration = (): void => {
    generation += 1;
    clearTimer(midnightTimer);
    clearTimer(retryTimer);
    midnightTimer = null;
    retryTimer = null;
    attemptController?.abort();
    attemptController = null;
    inFlight = false;
    catchUpAfterPending = false;
  };

  const subscribeVisibility = (): void => {
    if (!visibilityDocument || visibilitySubscribed) return;
    visibilityDocument.addEventListener('visibilitychange', handleVisibilityChange);
    visibilitySubscribed = true;
  };

  const unsubscribeVisibility = (): void => {
    if (!visibilityDocument || !visibilitySubscribed) return;
    visibilityDocument.removeEventListener('visibilitychange', handleVisibilityChange);
    visibilitySubscribed = false;
  };

  const scheduleNextMidnight = (instant: Date): void => {
    clearTimer(midnightTimer);
    const delayMs = Math.max(0, nextMalaysiaMidnightAfter(instant).getTime() - instant.getTime());
    const timerGeneration = generation;
    midnightTimer = scheduleTimeout(() => {
      midnightTimer = null;
      if (timerGeneration === generation) checkNow();
    }, delayMs);
  };

  const runAttempt = (retryNumber: number, attemptGeneration: number): void => {
    if (!active || disposed || inFlight || attemptGeneration !== generation) return;

    inFlight = true;
    const controller = new AbortController();
    attemptController = controller;

    let result: Promise<void>;
    try {
      result = Promise.resolve(refreshTotals({ signal: controller.signal }));
    } catch (error) {
      result = Promise.reject(error);
    }

    void result.then(
      () => {
        if (attemptGeneration !== generation || disposed) return;
        inFlight = false;
        attemptController = null;
        clearTimer(retryTimer);
        retryTimer = null;
        options.onRefreshError(null);

        const currentDate = malaysiaDateAt(now());
        if (catchUpAfterPending || currentDate !== observedDate) {
          catchUpAfterPending = false;
          observedDate = currentDate;
          beginRefresh();
        }
      },
      (error: unknown) => {
        if (attemptGeneration !== generation || disposed) return;
        inFlight = false;
        attemptController = null;

        const currentDate = malaysiaDateAt(now());
        if (catchUpAfterPending || currentDate !== observedDate) {
          catchUpAfterPending = false;
          observedDate = currentDate;
          beginRefresh();
          return;
        }

        if (retryNumber < MAX_RETRIES) {
          retryTimer = scheduleTimeout(() => {
            retryTimer = null;
            runAttempt(retryNumber + 1, attemptGeneration);
          }, RETRY_DELAY_MS);
        } else {
          options.onRefreshError(error);
        }
      },
    );
  };

  const beginRefresh = (): void => {
    clearTimer(retryTimer);
    retryTimer = null;
    runAttempt(0, generation);
  };

  function checkNow(): void {
    if (!active || disposed) return;
    const instant = now();
    const currentDate = malaysiaDateAt(instant);
    scheduleNextMidnight(instant);

    if (currentDate !== observedDate) {
      observedDate = currentDate;
      if (inFlight) {
        catchUpAfterPending = true;
        attemptController?.abort();
        return;
      }
      beginRefresh();
    }
  }

  function handleVisibilityChange(): void {
    if (visibilityDocument?.visibilityState === 'hidden') return;
    checkNow();
  }

  const activateCurrentScope = (): void => {
    active = !hasExplicitDateBoundary(scope);
    if (!active || disposed) {
      unsubscribeVisibility();
      return;
    }

    observedDate = malaysiaDateAt(now());
    subscribeVisibility();
    scheduleNextMidnight(now());
  };

  const update = (next: MalaysiaMidnightControllerUpdate): void => {
    if (disposed) return;
    cancelGeneration();
    scope = next.scope;
    refreshTotals = next.refreshTotals;
    activateCurrentScope();
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    active = false;
    cancelGeneration();
    unsubscribeVisibility();
  };

  activateCurrentScope();

  return { update, checkNow, dispose };
};
