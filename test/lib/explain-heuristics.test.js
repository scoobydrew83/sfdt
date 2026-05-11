import { describe, it, expect } from 'vitest';
import { runHeuristicAnalysis, NO_MATCH_MESSAGE } from '../../src/lib/explain-heuristics.js';

describe('runHeuristicAnalysis', () => {
  it('returns found=false and a no-matches markdown when log has no known patterns', () => {
    const { found, findings, markdown } = runHeuristicAnalysis('Everything deployed successfully.');
    expect(found).toBe(false);
    expect(findings.length).toBe(0);
    expect(markdown).toContain(NO_MATCH_MESSAGE);
    expect(markdown).toContain('Enable AI');
  });

  it('detects missing-field pattern', () => {
    const log = "No such column 'Amount' on entity 'Opportunity'";
    const { found, markdown } = runHeuristicAnalysis(log);
    expect(found).toBe(true);
    expect(markdown).toContain('Amount');
    expect(markdown).toContain('Opportunity');
  });

  it('detects coverage failure', () => {
    const log = 'Average test coverage across all Apex Classes and Triggers is 60%';
    const { found, markdown } = runHeuristicAnalysis(log);
    expect(found).toBe(true);
    expect(markdown).toContain('60%');
  });

  it('deduplicates repeated matches', () => {
    const log = [
      "No such column 'Amount' on entity 'Opportunity'",
      "No such column 'Amount' on entity 'Opportunity'",
    ].join('\n');
    const { found, findings, markdown } = runHeuristicAnalysis(log);
    expect(found).toBe(true);
    expect(findings.length).toBe(1);
    const count = (markdown.match(/Amount/g) ?? []).length;
    expect(count).toBe(1);
  });
});
