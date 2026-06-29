import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createApexTestRunnerFeature,
  shapeTestResults,
  isTerminalStatus,
  type RawApexTestResultRow,
} from '../features/apex-test-runner.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

interface FakeApi {
  apiVersion: string;
  apiRequest: ReturnType<typeof vi.fn>;
  toolingQuery: ReturnType<typeof vi.fn>;
}

function fakeApi(over: Partial<FakeApi>): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    apiRequest: vi.fn(async () => 'job1'),
    toolingQuery: vi.fn(async () => ({ records: [], size: 0, done: true })),
    ...over,
  } as unknown as SalesforceApiClient;
}

function clickRun(): void {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Run')!;
  btn.click();
}

describe('shapeTestResults', () => {
  it('counts pass/fail/skip and lists failing methods with messages', () => {
    const rows: RawApexTestResultRow[] = [
      { Outcome: 'Pass', MethodName: 'a', ApexClass: { Name: 'OkTest' } },
      { Outcome: 'Fail', MethodName: 'testX', ApexClass: { Name: 'MyTest' }, Message: 'boom' },
      { Outcome: 'Skip', MethodName: 's', ApexClass: { Name: 'SkipTest' } },
      { Outcome: 'CompileFail', MethodName: 'c', ApexClass: { Name: 'CTest' }, Message: 'no compile' },
    ];
    const out = shapeTestResults(rows);
    expect(out.total).toBe(4);
    expect(out.passed).toBe(1);
    expect(out.failed).toBe(2);
    expect(out.skipped).toBe(1);
    expect(out.failures.map((f) => f.name)).toEqual(['CTest.c', 'MyTest.testX']); // sorted
    expect(out.failures[0]!.message).toBe('no compile');
  });

  it('falls back to (unknown) for missing class/method names', () => {
    const out = shapeTestResults([{ Outcome: 'Fail' }]);
    expect(out.failures[0]!.name).toBe('(unknown).(unknown)');
  });
});

describe('isTerminalStatus', () => {
  it('treats Completed/Failed/Aborted as terminal', () => {
    expect(isTerminalStatus('Completed')).toBe(true);
    expect(isTerminalStatus('Failed')).toBe(true);
    expect(isTerminalStatus('Aborted')).toBe(true);
    expect(isTerminalStatus('Processing')).toBe(false);
    expect(isTerminalStatus(null)).toBe(false);
  });
});

describe('apex-test-runner feature', () => {
  beforeEach(clearBody);

  it('submits a run, polls for completion, and renders counts + failures', async () => {
    // A realistic 18-char Salesforce AsyncApexJob id (707 prefix) — the runner now
    // validates the id format before interpolating it into SOQL.
    const apiRequest = vi.fn((_method: string, _endpoint: string, _body?: unknown) => Promise.resolve('707000000000000001'));
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('ApexTestRunResult')) {
        return { records: [{ Status: 'Completed' }], size: 1, done: true };
      }
      return {
        records: [
          { Outcome: 'Pass', MethodName: 'a', ApexClass: { Name: 'OkTest' } },
          { Outcome: 'Fail', MethodName: 'testX', ApexClass: { Name: 'MyTest' }, Message: 'kaboom' },
        ],
        size: 2,
        done: true,
      };
    });
    const feature = createApexTestRunnerFeature({
      api: fakeApi({ apiRequest, toolingQuery }),
      pollIntervalMs: 0,
      maxPolls: 3,
    });
    await feature.onActivate?.();
    clickRun();

    await vi.waitFor(() => expect(document.body.textContent).toContain('1 passed'));
    const text = document.body.textContent ?? '';
    expect(apiRequest).toHaveBeenCalledOnce();
    expect(apiRequest.mock.calls[0]![0]).toBe('POST');
    expect(text).toContain('1 passed · 1 failed');
    expect(text).toContain('MyTest.testX');
    expect(text).toContain('kaboom');
  });

  it('errors when Salesforce returns no run id', async () => {
    const feature = createApexTestRunnerFeature({
      api: fakeApi({ apiRequest: vi.fn(async () => null) }),
      pollIntervalMs: 0,
    });
    await feature.onActivate?.();
    clickRun();
    await vi.waitFor(() => expect(document.body.textContent).toContain('did not return a test run id'));
  });

  it('surfaces a submit error in an error panel', async () => {
    const feature = createApexTestRunnerFeature({
      api: fakeApi({ apiRequest: vi.fn(async () => { throw new Error('INVALID_SESSION'); }) }),
      pollIntervalMs: 0,
    });
    await feature.onActivate?.();
    clickRun();
    await vi.waitFor(() => expect(document.body.textContent).toContain('INVALID_SESSION'));
  });
});
