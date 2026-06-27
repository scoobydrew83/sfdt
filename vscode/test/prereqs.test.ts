import { describe, it, expect } from 'vitest';
import { evaluatePrereqs } from '../src/lib/prereqs.js';

describe('evaluatePrereqs', () => {
  it('is ready when sf, sfdt, and config are all present', () => {
    const state = evaluatePrereqs({ hasSf: true, hasSfdt: true, hasConfig: true });
    expect(state.ready).toBe(true);
    expect(state.missing).toEqual([]);
  });

  it('reports missing sf and sfdt first', () => {
    const state = evaluatePrereqs({ hasSf: false, hasSfdt: false, hasConfig: false });
    expect(state.ready).toBe(false);
    expect(state.missing.map((m) => m.id)).toEqual(['install-sf', 'install-sfdt']);
  });

  it('only prompts for init once sfdt exists', () => {
    const withoutSfdt = evaluatePrereqs({ hasSf: true, hasSfdt: false, hasConfig: false });
    expect(withoutSfdt.missing.map((m) => m.id)).not.toContain('init');

    const withSfdt = evaluatePrereqs({ hasSf: true, hasSfdt: true, hasConfig: false });
    expect(withSfdt.missing.map((m) => m.id)).toEqual(['init']);
  });
});
