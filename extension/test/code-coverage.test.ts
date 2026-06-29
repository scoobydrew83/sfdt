import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createCodeCoverageFeature,
  shapeCoverage,
  coverageBand,
  type RawCoverageRow,
} from '../features/code-coverage.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function fakeApi(toolingQuery: (soql: string) => Promise<{ records: unknown[]; size: number; done: boolean }>): SalesforceApiClient {
  return { toolingQuery } as unknown as SalesforceApiClient;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('shapeCoverage', () => {
  it('computes pct, total and sorts worst-coverage first', () => {
    const rows: RawCoverageRow[] = [
      { ApexClassOrTrigger: { Name: 'Good' }, NumLinesCovered: 95, NumLinesUncovered: 5 },
      { ApexClassOrTrigger: { Name: 'Bad' }, NumLinesCovered: 2, NumLinesUncovered: 8 },
    ];
    const out = shapeCoverage(rows);
    expect(out[0]!.name).toBe('Bad'); // worst first
    expect(out[0]!.pct).toBeCloseTo(0.2);
    expect(out[0]!.total).toBe(10);
    expect(out[1]!.name).toBe('Good');
    expect(out[1]!.pct).toBeCloseTo(0.95);
  });

  it('treats no-line components as null pct and sorts them last', () => {
    const out = shapeCoverage([
      { ApexClassOrTrigger: { Name: 'Empty' }, NumLinesCovered: 0, NumLinesUncovered: 0 },
      { ApexClassOrTrigger: { Name: 'Real' }, NumLinesCovered: 5, NumLinesUncovered: 5 },
    ]);
    expect(out[0]!.name).toBe('Real');
    expect(out[1]!.name).toBe('Empty');
    expect(out[1]!.pct).toBeNull();
  });

  it('falls back to (unknown) when the name is missing', () => {
    const out = shapeCoverage([{ NumLinesCovered: 1, NumLinesUncovered: 1 }]);
    expect(out[0]!.name).toBe('(unknown)');
  });
});

describe('coverageBand', () => {
  it('red below 75%, amber 75–90%, green at/above 90%', () => {
    expect(coverageBand(0.5)).toBe('red');
    expect(coverageBand(0.74)).toBe('red');
    expect(coverageBand(0.75)).toBe('amber');
    expect(coverageBand(0.89)).toBe('amber');
    expect(coverageBand(0.9)).toBe('green');
    expect(coverageBand(null)).toBe('none');
  });
});

describe('code-coverage feature', () => {
  beforeEach(clearBody);

  it('queries Tooling and renders org-wide % + per-class cards', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.includes('ApexOrgWideCoverage')) {
        return { records: [{ PercentCovered: 82 }], size: 1, done: true };
      }
      return {
        records: [
          { ApexClassOrTrigger: { Name: 'AccountSvc' }, NumLinesCovered: 8, NumLinesUncovered: 2 },
        ],
        size: 1,
        done: true,
      };
    });
    const feature = createCodeCoverageFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    expect(toolingQuery).toHaveBeenCalledTimes(2);
    const text = document.body.textContent ?? '';
    expect(text).toContain('82%'); // org-wide banner
    expect(text).toContain('AccountSvc');
    expect(text).toContain('80.0%'); // 8/10
  });

  it('shows a friendly empty state when there is no coverage data', async () => {
    const toolingQuery = vi.fn(async () => ({ records: [], size: 0, done: true }));
    const feature = createCodeCoverageFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('Run Apex tests');
  });

  it('surfaces a query error in an error panel', async () => {
    const toolingQuery = vi.fn(async () => { throw new Error('INVALID_TYPE: coverage'); });
    const feature = createCodeCoverageFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('INVALID_TYPE');
  });
});
