import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { TrialBalanceChecks } from './TrialBalanceChecks';
import { computeCertificationReadiness } from '@/lib/workspace/computeCertificationReadiness';
import { deriveTrialBalanceVerdict } from '@/lib/workspace/trialBalanceVerdict';

it('renders a stopped real result without green balance or classification claims', () => {
  const processing_result = { ingestion: { milestones: [
    { id: 'read', label: 'File read', status: 'passed' },
    { id: 'columns', label: 'Columns', status: 'failed' },
    { id: 'rows', label: 'Rows', status: 'not_reached' },
    { id: 'amounts', label: 'Amounts', status: 'not_reached' },
    { id: 'balance', label: 'Balance', status: 'not_reached' },
    { id: 'classification', label: 'Classification', status: 'not_reached' },
  ] } };
  const readiness = computeCertificationReadiness({ uploadExists: true, currentUploadId: 'synthetic-upload', authoritative: null,
    latestForUpload: { id: 'cert', sequence_no: 1, company_id: 'synthetic-entity', upload_id: 'synthetic-upload', period_year: 2026, is_blocking: true, requires_review: false, certified_at: '2026-10-15', exceptions: [{ code: 'MISSING_COLUMN', layer: 2, severity: 'error', accountCode: null, message: 'Confirm the amount columns.' }] }, processingResult: processing_result });
  const verdict = deriveTrialBalanceVerdict({ upload: { id: 'synthetic-upload', status: 'blocked', processing_result }, readiness, canRetry: true });
  const html = renderToStaticMarkup(createElement(TrialBalanceChecks, { verdict }));
  expect(html).toContain('1 of 4 passed');
  expect(html).toContain('data-testid="check-l3_arithmetic" data-state="not_evaluated"');
  expect(html).toContain('data-testid="check-l4_classification" data-state="not_evaluated"');
  expect(html).not.toContain('Every account has a classification.');
  expect(html).not.toContain('Total debits equal total credits.');
  expect(html).toContain('Not completed:');
});
