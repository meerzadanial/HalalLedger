import { cleanup, render, screen } from '@testing-library/react';
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import BulkReportPanel, { type BulkReportApi } from './BulkReportPanel';
import type { ReportFailureStage, ReportRequestDto, ReportStatus } from '../services/api';

const statuses = ['pending', 'processing', 'email_submitted', 'email_accepted', 'sent'] as const satisfies readonly Exclude<ReportStatus, 'failed'>[];
const failureStages = ['data_retrieval', 'snapshot', 'csv_generation', 'report_size', 'email_submission', 'unexpected'] as const satisfies readonly ReportFailureStage[];
type PresentationCase =
  | { status: Exclude<ReportStatus, 'failed'>; failureStage: null }
  | { status: 'failed'; failureStage: ReportFailureStage };
const presentationCase: fc.Arbitrary<PresentationCase> = fc.oneof(
  fc.constantFrom(...statuses).map((status) => ({ status, failureStage: null })),
  fc.constantFrom(...failureStages).map((failureStage) => ({ status: 'failed' as const, failureStage })),
);

const requestFor = ({ status, failureStage }: PresentationCase): ReportRequestDto => ({
  id: `request-${status}-${failureStage ?? 'none'}`,
  reportType: 'weekly',
  referenceDate: '2025-01-08',
  period: { startDate: '2025-01-06', endDate: '2025-01-12', inclusive: true },
  accountEmail: `${status}-${failureStage ?? 'none'}@example.com`,
  status,
  progressStage: status === 'pending' ? 'data_retrieval' : status === 'failed' ? (failureStage === 'report_size' || failureStage === 'unexpected' ? 'csv_generation' : failureStage) : status === 'processing' ? 'snapshot' : status === 'email_submitted' ? 'email_submission' : 'delivery_wait',
  createdAt: '2025-01-08T10:00:00Z',
  providerAcceptedAt: status === 'email_accepted' || status === 'sent' ? '2025-01-08T10:00:02Z' : null,
  sentAt: status === 'sent' ? '2025-01-08T10:00:04Z' : null,
  failure: failureStage ? { code: `failed_${failureStage}`, stage: failureStage, message: 'Safe failure.' } : null,
  canRetry: status === 'failed',
});

describe('BulkReportPanel confirmed-success presentation property', () => {
  // Feature: bulk-csv-report-email, Property 22: Sent success is equivalent to confirmed sent state
  // **Validates: Requirements 7.7, 7.12**
  it('shows sent-success copy if and only if the request is SENT', async () => {
    await fc.assert(fc.asyncProperty(presentationCase, async (generated) => {
      const request = requestFor(generated);
      const api: BulkReportApi = {
        active: vi.fn().mockResolvedValue(request),
        resolve: vi.fn().mockResolvedValue({ reportType: request.reportType, referenceDate: request.referenceDate, period: request.period, accountEmail: request.accountEmail, timeZone: 'Asia/Kuala_Lumpur' }),
        create: vi.fn(), status: vi.fn(), retry: vi.fn(),
      };
      try {
        render(<BulkReportPanel api={api} />);
        await screen.findByText(request.accountEmail);
        const successCopy = `Your weekly CSV report was sent to ${request.accountEmail} for the inclusive period 2025-01-06 to 2025-01-12.`;
        expect(document.body.textContent?.includes(successCopy)).toBe(request.status === 'sent');
      } finally { cleanup(); }
    }), { numRuns: 100 });
  });
});