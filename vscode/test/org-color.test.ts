import { describe, it, expect } from 'vitest';
import { classifyOrg, colorForOrg } from '../src/lib/org-color.js';

describe('classifyOrg', () => {
  it('prioritizes explicit scratch/sandbox flags', () => {
    expect(classifyOrg({ isScratch: true })).toBe('scratch');
    expect(classifyOrg({ isSandbox: true })).toBe('sandbox');
    expect(classifyOrg({ isDevEdition: true })).toBe('developer');
  });
  it('treats a plain my.salesforce.com URL as production', () => {
    expect(classifyOrg({ instanceUrl: 'https://acme.my.salesforce.com' })).toBe('production');
  });
  it('detects sandbox-style URLs', () => {
    expect(classifyOrg({ instanceUrl: 'https://acme--dev.sandbox.my.salesforce.com' })).toBe('sandbox');
  });
  it('returns other when nothing is known', () => {
    expect(classifyOrg({})).toBe('other');
  });
});

describe('colorForOrg', () => {
  it('returns a red-ish tint for production', () => {
    const c = colorForOrg('production')!;
    expect(c['activityBar.background']).toBe('#8b1a1a');
    expect(c['statusBar.background']).toBe('#8b1a1a');
  });
  it('returns green for scratch and developer', () => {
    expect(colorForOrg('scratch')!['activityBar.background']).toBe('#1f7a3d');
    expect(colorForOrg('developer')!['activityBar.background']).toBe('#1f7a3d');
  });
  it('returns null for an unclassified org', () => {
    expect(colorForOrg('other')).toBeNull();
  });
});
