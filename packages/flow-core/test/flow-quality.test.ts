import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the pipeline modules so runFlowQuality is tested in isolation — we only
// care that it forwards the right rulesConfig + meta into them.
vi.mock('../src/normalize.js', () => ({
  normalize: vi.fn((metadata: { label?: string }, meta: object) => ({
    meta: { ...meta, label: metadata?.label },
    dependencies: [{ name: 'dep1' }],
  })),
}));
vi.mock('../src/rules.js', () => ({ evaluate: vi.fn(() => [{ id: 'rule-1', severity: 'high' }]) }));
vi.mock('../src/scorer.js', () => ({
  buildIssueFamilies: vi.fn(() => [{ family: 'fam-1' }]),
  calculateScore: vi.fn(() => ({ overallScore: 80, rating: 'Good' })),
}));

import { normalize } from '../src/normalize.js';
import { evaluate } from '../src/rules.js';
import { calculateScore } from '../src/scorer.js';
import { parseApiVersion, runFlowQuality, DEFAULT_RULES_CONFIG } from '../src/flow-quality.js';

beforeEach(() => vi.clearAllMocks());

describe('parseApiVersion', () => {
  it('parses bare and decorated version strings + numbers', () => {
    expect(parseApiVersion('62.0')).toBe(62);
    expect(parseApiVersion('v62.0')).toBe(62);
    expect(parseApiVersion('62')).toBe(62);
    expect(parseApiVersion(62)).toBe(62);
  });
  it('returns null for null/undefined/no-digits/non-positive', () => {
    expect(parseApiVersion(null)).toBeNull();
    expect(parseApiVersion(undefined)).toBeNull();
    expect(parseApiVersion('vNext')).toBeNull();
    expect(parseApiVersion('0')).toBeNull();
    expect(parseApiVersion(0)).toBeNull();
  });
});

describe('runFlowQuality', () => {
  it('uses DEFAULT_RULES_CONFIG and assembles the report shape', () => {
    const out = runFlowQuality({ label: 'My_Flow' } as never);
    expect(vi.mocked(evaluate)).toHaveBeenCalledWith(expect.anything(), DEFAULT_RULES_CONFIG);
    expect(out).toMatchObject({
      summary: { overallScore: 80, rating: 'Good' },
      issueFamilies: [{ family: 'fam-1' }],
      findings: [{ id: 'rule-1', severity: 'high' }],
      dependencies: [{ name: 'dep1' }],
    });
    expect(vi.mocked(normalize)).toHaveBeenCalledWith(
      { label: 'My_Flow' },
      { flowApiName: 'My_Flow', flowVersionId: null },
    );
  });

  it('falls back to "unknown_flow" when no name/label is provided', () => {
    runFlowQuality({} as never);
    expect(vi.mocked(normalize)).toHaveBeenCalledWith({}, { flowApiName: 'unknown_flow', flowVersionId: null });
  });

  it('honors explicit flowApiName and flowVersionId overrides', () => {
    runFlowQuality({ label: 'X' } as never, { flowApiName: 'Override', flowVersionId: '301xx' });
    expect(vi.mocked(normalize)).toHaveBeenCalledWith({ label: 'X' }, { flowApiName: 'Override', flowVersionId: '301xx' });
  });

  it('overrides currentApiVersion from a parseable string, preserving other defaults', () => {
    runFlowQuality({} as never, { currentApiVersion: 'v59.0' });
    const passed = vi.mocked(evaluate).mock.calls[0]![1] as { currentApiVersion: number; outdatedApiVersionThreshold: number };
    expect(passed.currentApiVersion).toBe(59);
    expect(passed).not.toBe(DEFAULT_RULES_CONFIG);
    expect(passed.outdatedApiVersionThreshold).toBe(DEFAULT_RULES_CONFIG.outdatedApiVersionThreshold);
  });

  it('ignores an unparseable currentApiVersion and prefers an explicit rulesConfig', () => {
    runFlowQuality({} as never, { currentApiVersion: 'garbage' });
    expect(vi.mocked(evaluate)).toHaveBeenCalledWith(expect.anything(), DEFAULT_RULES_CONFIG);
    vi.clearAllMocks();
    const rulesConfig = { currentApiVersion: 12 } as never;
    runFlowQuality({} as never, { rulesConfig, currentApiVersion: '99' });
    expect(vi.mocked(evaluate)).toHaveBeenCalledWith(expect.anything(), rulesConfig);
  });

  it('runs the score off the issue families', () => {
    runFlowQuality({ label: 'F' } as never);
    expect(vi.mocked(calculateScore)).toHaveBeenCalledWith([{ family: 'fam-1' }]);
  });
});
