import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the flow-core pipeline so runFlowQuality is tested in isolation; we only
// care that this module forwards the right rulesConfig + meta into it.
vi.mock('@sfdt/flow-core', () => ({
  normalize: vi.fn((metadata, meta) => ({
    meta: { ...meta, label: metadata?.label },
    dependencies: [{ name: 'dep1' }],
  })),
  evaluate: vi.fn(() => [{ id: 'rule-1', severity: 'high' }]),
  buildIssueFamilies: vi.fn(() => [{ family: 'fam-1' }]),
  calculateScore: vi.fn(() => ({ overallScore: 80, rating: 'Good' })),
}));

import { normalize, evaluate, calculateScore } from '@sfdt/flow-core';
import { parseApiVersion, runFlowQuality, DEFAULT_RULES_CONFIG } from '../../src/lib/flow-quality.js';

beforeEach(() => vi.clearAllMocks());

describe('parseApiVersion', () => {
  it('parses bare and decorated version strings', () => {
    expect(parseApiVersion('62.0')).toBe(62);
    expect(parseApiVersion('v62.0')).toBe(62);
    expect(parseApiVersion('62')).toBe(62);
  });

  it('accepts numeric input', () => {
    expect(parseApiVersion(62)).toBe(62);
  });

  it('returns null for null/undefined', () => {
    expect(parseApiVersion(null)).toBeNull();
    expect(parseApiVersion(undefined)).toBeNull();
  });

  it('returns null when no digits are present', () => {
    expect(parseApiVersion('vNext')).toBeNull();
  });

  it('returns null for non-positive values', () => {
    expect(parseApiVersion('0')).toBeNull();
    expect(parseApiVersion(0)).toBeNull();
  });
});

describe('runFlowQuality', () => {
  it('uses DEFAULT_RULES_CONFIG and assembles the report shape', () => {
    const out = runFlowQuality({ label: 'My_Flow' });

    expect(evaluate).toHaveBeenCalledWith(expect.anything(), DEFAULT_RULES_CONFIG);
    expect(out).toMatchObject({
      summary: { overallScore: 80, rating: 'Good' },
      issueFamilies: [{ family: 'fam-1' }],
      findings: [{ id: 'rule-1', severity: 'high' }],
      dependencies: [{ name: 'dep1' }],
    });
    // flowApiName falls back to metadata.label.
    expect(normalize).toHaveBeenCalledWith({ label: 'My_Flow' }, { flowApiName: 'My_Flow', flowVersionId: null });
  });

  it('falls back to "unknown_flow" when no name/label is provided', () => {
    runFlowQuality({});
    expect(normalize).toHaveBeenCalledWith({}, { flowApiName: 'unknown_flow', flowVersionId: null });
  });

  it('honors explicit flowApiName and flowVersionId overrides', () => {
    runFlowQuality({ label: 'X' }, { flowApiName: 'Override', flowVersionId: '301xx' });
    expect(normalize).toHaveBeenCalledWith({ label: 'X' }, { flowApiName: 'Override', flowVersionId: '301xx' });
  });

  it('overrides currentApiVersion from a parseable string', () => {
    runFlowQuality({}, { currentApiVersion: 'v59.0' });
    const passedConfig = evaluate.mock.calls[0][1];
    expect(passedConfig.currentApiVersion).toBe(59);
    expect(passedConfig).not.toBe(DEFAULT_RULES_CONFIG);
    // Other defaults are preserved.
    expect(passedConfig.outdatedApiVersionThreshold).toBe(DEFAULT_RULES_CONFIG.outdatedApiVersionThreshold);
  });

  it('ignores an unparseable currentApiVersion and keeps defaults', () => {
    runFlowQuality({}, { currentApiVersion: 'garbage' });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), DEFAULT_RULES_CONFIG);
  });

  it('prefers an explicit rulesConfig over currentApiVersion', () => {
    const rulesConfig = { currentApiVersion: 12, custom: true };
    runFlowQuality({}, { rulesConfig, currentApiVersion: '99' });
    expect(evaluate).toHaveBeenCalledWith(expect.anything(), rulesConfig);
  });

  it('runs the score calculation off the issue families', () => {
    runFlowQuality({ label: 'F' });
    expect(calculateScore).toHaveBeenCalledWith([{ family: 'fam-1' }]);
  });
});
