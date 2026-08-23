import { FormEvent, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  ReportApiError,
  reportsApi,
  type ReportFailureStage,
  type ReportProgressStage,
  type ReportRequestDto,
  type ReportType,
  type ResolveReportPeriodDto,
} from '../services/api';

export interface BulkReportApi {
  resolve(reportType: ReportType, referenceDate: string): Promise<ResolveReportPeriodDto>;
  create(input: { reportType: ReportType; referenceDate: string }): Promise<ReportRequestDto>;
  active(): Promise<ReportRequestDto | null>;
  status(reportRequestId: string): Promise<ReportRequestDto>;
  retry(reportRequestId: string): Promise<ReportRequestDto>;
}

interface BulkReportPanelProps {
  accountEmail?: string;
  api?: BulkReportApi;
  adjacentAction?: ReactNode;
}

interface LastResolvedSelection {
  reportType: ReportType;
  referenceDate: string;
  resolution: ResolveReportPeriodDto;
}

const TERMINAL_STATUSES = new Set<ReportRequestDto['status']>(['sent', 'failed']);
const OUTCOME_MESSAGE_LIMIT = 500;

const isTerminal = (request: ReportRequestDto | null): boolean =>
  request !== null && TERMINAL_STATUSES.has(request.status);

const capOutcomeMessage = (message: string): string =>
  message.length <= OUTCOME_MESSAGE_LIMIT
    ? message
    : `${message.slice(0, OUTCOME_MESSAGE_LIMIT - 1).trimEnd()}…`;

const progressMessages: Record<ReportProgressStage, string> = {
  data_retrieval: 'Retrieving all delivery entries for the inclusive report period.',
  snapshot: 'Preparing the report data snapshot.',
  csv_generation: 'Generating the CSV report.',
  email_submission: 'Submitting the report email.',
  delivery_wait: 'Waiting for email delivery confirmation.',
};

const failureMessages: Record<ReportFailureStage, string> = {
  data_retrieval: 'Report data retrieval failed.',
  snapshot: 'Report generation failed while preparing the data snapshot.',
  csv_generation: 'CSV report generation failed.',
  report_size: 'The CSV report exceeded the email attachment size limit.',
  email_submission: 'Report email submission failed before delivery was confirmed.',
  unexpected: 'The report failed because of an unexpected error.',
};

const getValidationMessage = (error: unknown): string => {
  if (!(error instanceof ReportApiError)) {
    return 'The report period could not be validated. Please try again.';
  }

  switch (error.code) {
    case 'missing_reference_date':
      return 'Choose a report reference date.';
    case 'invalid_reference_date':
      return 'Enter a valid calendar date.';
    case 'future_reference_date':
      return 'Future dates are not permitted.';
    case 'invalid_report_type':
      return 'Choose Weekly or Monthly.';
    case 'authentication_required':
    case 'unauthorized':
      return 'Authentication is required to request a report.';
    default:
      return 'The report period could not be validated. Please try again.';
  }
};

const getActionErrorMessage = (error: unknown): string => {
  if (!(error instanceof ReportApiError)) {
    return 'The report request could not be completed. Please try again.';
  }
  if (error.status === 401 || error.code === 'authentication_required' || error.code === 'unauthorized') {
    return 'Authentication is required to request a report.';
  }
  if (error.code === 'report_in_progress') {
    return 'A report request is already in progress.';
  }
  return 'The report request could not be completed. Please try again.';
};

const buildProgressMessage = (request: ReportRequestDto): string => {
  if (request.status === 'pending') return 'Report in progress. Report request queued.';
  if (request.status === 'email_accepted') {
    return 'Report in progress. Waiting for delivery confirmation.';
  }
  return `Report in progress. ${progressMessages[request.progressStage]}`;
};

const buildSuccessMessage = (request: ReportRequestDto): string =>
  capOutcomeMessage(
    `Your ${request.reportType} CSV report was sent to ${request.accountEmail} for the inclusive period ${request.period.startDate} to ${request.period.endDate}.`,
  );

const buildFailureMessage = (request: ReportRequestDto): string => {
  const stage = request.failure?.stage ?? 'unexpected';
  return capOutcomeMessage(
    `${failureMessages[stage]} The report was not sent to ${request.accountEmail} for the inclusive period ${request.period.startDate} to ${request.period.endDate}.`,
  );
};

export default function BulkReportPanel({
  accountEmail = '',
  api = reportsApi,
  adjacentAction,
}: BulkReportPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [reportType, setReportType] = useState<ReportType>('weekly');
  const [referenceDate, setReferenceDate] = useState('');
  const [lastResolved, setLastResolved] = useState<LastResolvedSelection | null>(null);
  const [request, setRequest] = useState<ReportRequestDto | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const [resolving, setResolving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [pollIteration, setPollIteration] = useState(0);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');

  const firstRadioRef = useRef<HTMLInputElement>(null);
  const hasMovedInitialFocus = useRef(false);
  const shouldMoveFocusOnExpand = useRef(false);
  const resolutionSequence = useRef(0);
  const actionLocked = useRef(false);
  const pollingStart = useRef<{ requestId: string; startedAt: number } | null>(null);

  const activeRequest = request !== null && !isTerminal(request);
  const failedRequest = request?.status === 'failed';
  const selectionLocked = activeRequest || failedRequest;
  const currentSelectionIsResolved = lastResolved !== null
    && lastResolved.reportType === reportType
    && lastResolved.referenceDate === referenceDate;
  const displayedRecipient = request?.accountEmail
    ?? lastResolved?.resolution.accountEmail
    ?? accountEmail;

  const statusMessage = useMemo(() => {
    if (!request) return restoring ? 'Checking for an active report request.' : '';
    if (request.status === 'sent') return buildSuccessMessage(request);
    if (request.status === 'failed') return '';
    return buildProgressMessage(request);
  }, [request, restoring]);

  const failureMessage = request?.status === 'failed'
    ? buildFailureMessage(request)
    : actionError;

  const applyRequest = (nextRequest: ReportRequestDto) => {
    setRequest(nextRequest);
    setReportType(nextRequest.reportType);
    setReferenceDate(nextRequest.referenceDate);
    setLastResolved({
      reportType: nextRequest.reportType,
      referenceDate: nextRequest.referenceDate,
      resolution: {
        reportType: nextRequest.reportType,
        referenceDate: nextRequest.referenceDate,
        period: nextRequest.period,
        accountEmail: nextRequest.accountEmail,
        timeZone: '',
      },
    });
    setValidationMessage(null);
    setActionError(null);
  };

  useEffect(() => {
    let mounted = true;
    const restoreActiveRequest = async () => {
      try {
        const active = await api.active();
        if (!mounted || active === null) return;
        applyRequest(active);
        setExpanded(true);
      } catch (error) {
        if (mounted) setActionError(getActionErrorMessage(error));
      } finally {
        if (mounted) setRestoring(false);
      }
    };
    void restoreActiveRequest();
    return () => { mounted = false; };
  }, [api]);

  useEffect(() => {
    const handleVisibilityChange = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (!expanded || selectionLocked || referenceDate === '') {
      setResolving(false);
      return;
    }

    const sequence = ++resolutionSequence.current;
    setResolving(true);
    setValidationMessage(null);
    void api.resolve(reportType, referenceDate)
      .then((resolution) => {
        if (sequence !== resolutionSequence.current) return;
        setLastResolved({ reportType, referenceDate, resolution });
      })
      .catch((error: unknown) => {
        if (sequence !== resolutionSequence.current) return;
        setValidationMessage(getValidationMessage(error));
      })
      .finally(() => {
        if (sequence === resolutionSequence.current) setResolving(false);
      });
  }, [api, expanded, referenceDate, reportType, selectionLocked]);

  useEffect(() => {
    if (!request || isTerminal(request) || !pageVisible) return;

    if (pollingStart.current?.requestId !== request.id) {
      pollingStart.current = { requestId: request.id, startedAt: Date.now() };
    }
    const elapsed = Date.now() - pollingStart.current.startedAt;
    const delay = elapsed >= 30_000 ? 5_000 : 2_000;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void api.status(request.id)
        .then((updated) => {
          if (!cancelled) {
            applyRequest(updated);
            setPollIteration((iteration) => iteration + 1);
          }
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setActionError(getActionErrorMessage(error));
            setPollIteration((iteration) => iteration + 1);
          }
        });
    }, delay);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [api, pageVisible, pollIteration, request]);

  useEffect(() => {
    if (!expanded || !shouldMoveFocusOnExpand.current) return;
    shouldMoveFocusOnExpand.current = false;
    firstRadioRef.current?.focus();
  }, [expanded]);

  const handleToggle = () => {
    const opening = !expanded;
    if (opening && !hasMovedInitialFocus.current) {
      hasMovedInitialFocus.current = true;
      shouldMoveFocusOnExpand.current = true;
    }
    setExpanded(opening);
  };

  const handleReportTypeChange = (nextType: ReportType) => {
    resolutionSequence.current += 1;
    setReportType(nextType);
    setValidationMessage(null);
    setActionError(null);
  };

  const handleReferenceDateChange = (nextDate: string) => {
    resolutionSequence.current += 1;
    setReferenceDate(nextDate);
    setValidationMessage(nextDate === '' ? 'Choose a report reference date.' : null);
    setActionError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (actionLocked.current || activeRequest || failedRequest || restoring) {
      setActionError('A report request is already in progress.');
      return;
    }
    if (!currentSelectionIsResolved || resolving) {
      setValidationMessage(referenceDate === ''
        ? 'Choose a report reference date.'
        : 'Validate the selected report period before submitting.');
      return;
    }

    actionLocked.current = true;
    setSubmitting(true);
    setActionError(null);
    try {
      applyRequest(await api.create({ reportType, referenceDate }));
    } catch (error) {
      if (error instanceof ReportApiError && error.activeRequest) {
        applyRequest(error.activeRequest);
        setActionError('A report request is already in progress.');
      } else {
        setActionError(getActionErrorMessage(error));
      }
    } finally {
      actionLocked.current = false;
      setSubmitting(false);
    }
  };

  const handleRetry = async () => {
    if (!request || request.status !== 'failed' || !request.canRetry || actionLocked.current) return;
    actionLocked.current = true;
    setRetrying(true);
    setActionError(null);
    try {
      applyRequest(await api.retry(request.id));
    } catch (error) {
      if (error instanceof ReportApiError && error.activeRequest) {
        applyRequest(error.activeRequest);
        setActionError('A report request is already in progress.');
      } else {
        setActionError(getActionErrorMessage(error));
      }
    } finally {
      actionLocked.current = false;
      setRetrying(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={expanded}
        aria-controls="bulk-report-content"
        className="bulk-report-panel__action row-start-2 inline-flex min-h-[44px] min-w-[44px] w-full min-w-0 items-center justify-center gap-2 rounded-md border border-indigo-600 bg-white px-4 py-2 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 md:col-start-2 md:row-start-1 md:w-auto"
      >
        <span id="bulk-report-heading" className="min-w-0 break-words">Bulk Print / Email CSV</span>
        <span aria-hidden="true" className="shrink-0 text-lg leading-none">{expanded ? '−' : '+'}</span>
      </button>

      {adjacentAction}

      {expanded && (
        <section
          id="bulk-report-content"
          className="bulk-report-panel col-span-full row-start-4 min-w-0 rounded-lg border border-gray-200 bg-gray-50 px-4 py-5 md:row-start-2 sm:px-6"
          aria-labelledby="bulk-report-heading"
        >
          <form onSubmit={handleSubmit} className="min-w-0 space-y-5" noValidate>
            <fieldset disabled={activeRequest || request?.status === 'failed'} className="min-w-0">
              <legend className="text-sm font-medium text-gray-900">Report type</legend>
              <div className="mt-2 flex min-w-0 flex-col gap-2 sm:flex-row sm:gap-6">
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-700 focus-within:ring-2 focus-within:ring-indigo-500">
                  <input
                    ref={firstRadioRef}
                    type="radio"
                    name="bulk-report-type"
                    value="weekly"
                    checked={reportType === 'weekly'}
                    onChange={() => handleReportTypeChange('weekly')}
                    className="h-4 w-4 border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  Weekly
                </label>
                <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-gray-700 focus-within:ring-2 focus-within:ring-indigo-500">
                  <input
                    type="radio"
                    name="bulk-report-type"
                    value="monthly"
                    checked={reportType === 'monthly'}
                    onChange={() => handleReportTypeChange('monthly')}
                    className="h-4 w-4 border-gray-300 text-indigo-600 focus:ring-indigo-500"
                  />
                  Monthly
                </label>
              </div>
            </fieldset>

            <div className="grid min-w-0 grid-cols-1 gap-5 md:grid-cols-2">
              <div className="min-w-0">
                <label htmlFor="bulk-report-reference-date" className="block text-sm font-medium text-gray-700">
                  Report reference date
                </label>
                <input
                  id="bulk-report-reference-date"
                  type="date"
                  required
                  disabled={selectionLocked}
                  value={referenceDate}
                  onChange={(event) => handleReferenceDateChange(event.target.value)}
                  aria-describedby="bulk-report-date-help bulk-report-date-error"
                  aria-invalid={Boolean(validationMessage)}
                  className="mt-1 block min-h-[44px] w-full min-w-0 rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-gray-100 sm:text-sm"
                />
                <p id="bulk-report-date-help" className="mt-1 break-words text-xs text-gray-500">
                  Choose any date in the week or month you want to report.
                </p>
                {(validationMessage || referenceDate === '') && (
                  <p id="bulk-report-date-error" role="alert" aria-atomic="true" className="mt-1 min-h-[1.25rem] break-words text-sm text-red-700">
                    {validationMessage ?? 'Choose a report reference date.'}
                  </p>
                )}
              </div>

              <dl className="min-w-0 rounded-md bg-gray-50 p-4 text-sm">
                <div className="min-w-0">
                  <dt className="font-medium text-gray-700">Report recipient</dt>
                  <dd className="mt-1 min-w-0 break-words text-gray-900 [overflow-wrap:anywhere]">
                    {displayedRecipient || 'Account email unavailable'}
                  </dd>
                  <dd className="mt-1 text-xs text-gray-500">This is your read-only account email.</dd>
                </div>
                {lastResolved && (
                  <div className="mt-4 min-w-0">
                    <dt className="font-medium text-gray-700">
                      {currentSelectionIsResolved ? 'Report period' : 'Last valid report period'}
                    </dt>
                    <dd className="mt-1 break-words text-gray-900">
                      {lastResolved.resolution.period.startDate} to {lastResolved.resolution.period.endDate} (inclusive)
                    </dd>
                  </div>
                )}
              </dl>
            </div>

            <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="submit"
                disabled={activeRequest || failedRequest || restoring || submitting || resolving || !currentSelectionIsResolved}
                className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-transparent bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-gray-400 sm:w-auto"
              >
                {submitting ? 'Requesting report…' : 'Email CSV report'}
              </button>
              {resolving && <span className="break-words text-sm text-gray-600">Validating report period…</span>}
              {activeRequest && <span className="break-words text-sm text-gray-600">Another report cannot be submitted while this request is in progress.</span>}
            </div>
          </form>

          <div role="status" aria-live="polite" aria-atomic="true" className="mt-4 min-w-0 break-words text-sm text-gray-700">
            {statusMessage}
          </div>

          {failureMessage && (
            <div role="alert" aria-atomic="true" className="mt-4 min-w-0 rounded-md bg-red-50 p-4 text-sm text-red-800 [overflow-wrap:anywhere]">
              <p>{failureMessage}</p>
              {request?.status === 'failed' && (
                <button
                  type="button"
                  onClick={handleRetry}
                  disabled={retrying || !request.canRetry}
                  className="mt-3 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-red-300 bg-white px-4 py-2 font-medium text-red-800 shadow-sm hover:bg-red-100 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {retrying ? 'Retrying report…' : 'Retry report'}
                </button>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
