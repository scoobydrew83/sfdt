import { describe, it, expect } from 'vitest';
import {
  buildPaletteSources,
  enabledFeatureIds,
  type FeatureGate,
  type PaletteSection,
} from '../lib/palette-sources.js';
import { BASE_TABS } from '../lib/setup-links.js';

const ICONS = {
  'soql-runner': { icon: '🗂', label: 'SOQL Query Runner' },
  'org-limits': { icon: '🚦', label: 'Org Limits' },
  'inspect-record': { icon: '🔍', label: 'Inspect Record' },
};

// available: all three; org-limits user-disabled; inspect-record kill-switched.
function gate(overrides: Partial<FeatureGate> = {}): FeatureGate {
  return {
    available: ['soql-runner', 'org-limits', 'inspect-record'],
    isRegistered: () => true,
    disabledRemote: new Set(['inspect-record']),
    isEnabled: (id) => id !== 'org-limits',
    ...overrides,
  };
}

function sectionFor(sections: PaletteSection[], category: string): PaletteSection | undefined {
  return sections.find((s) => s.category === category);
}

function allCandidates(sections: PaletteSection[]) {
  return sections.flatMap((s) => s.candidates);
}

describe('extension/lib/palette-sources — enabledFeatureIds', () => {
  it('filters to available ∩ registered ∩ !kill-switched ∩ user-enabled (AC-3)', () => {
    expect(enabledFeatureIds(gate())).toEqual(['soql-runner']);
  });

  it('drops unregistered ids', () => {
    expect(enabledFeatureIds(gate({ isRegistered: (id) => id !== 'soql-runner', isEnabled: () => true, disabledRemote: new Set() }))).toEqual(
      ['org-limits', 'inspect-record'],
    );
  });
});

describe('extension/lib/palette-sources — buildPaletteSources', () => {
  const base = {
    gate: gate(),
    featureIcons: ICONS,
    setupLinks: BASE_TABS,
    hostname: 'x.lightning.force.com',
  };

  it('omits a disabled feature and a kill-switched feature; keeps the enabled one (AC-3)', () => {
    const sections = buildPaletteSources(base);
    const labels = allCandidates(sections).map((c) => c.label);
    expect(labels).toContain('SOQL Query Runner'); // enabled
    expect(labels).not.toContain('Org Limits'); // user-disabled
    expect(labels).not.toContain('Inspect Record'); // kill-switched
  });

  it('assembles per-category sections', () => {
    const sections = buildPaletteSources(base);
    expect(sectionFor(sections, 'feature')?.candidates).toHaveLength(1);
    // BASE_TABS deep-links all land in the Setup section.
    expect(sectionFor(sections, 'setup')?.candidates).toHaveLength(BASE_TABS.length);
    expect(sectionFor(sections, 'object')).toBeUndefined(); // stub is empty
  });

  it('materialises setup-link URLs for the current org', () => {
    const sections = buildPaletteSources(base);
    const flows = sectionFor(sections, 'setup')?.candidates.find((c) => c.apiName === 'sfdt_tab_flows');
    expect(flows?.action).toEqual({
      kind: 'url',
      url: 'https://x.my.salesforce-setup.com/lightning/setup/Flows/home',
      newTab: false,
    });
  });

  it('includes custom shortcuts as url actions', () => {
    const sections = buildPaletteSources({
      ...base,
      customShortcuts: [{ id: 'sc1', label: 'My Report', url: 'https://example.com', openInNewTab: true }],
    });
    const shortcut = sectionFor(sections, 'shortcut')?.candidates[0];
    expect(shortcut?.label).toBe('My Report');
    expect(shortcut?.action).toEqual({ kind: 'url', url: 'https://example.com', newTab: true });
  });

  it('routes a real record Id to an inspect candidate, at the top', () => {
    // inspect-record must be enabled for the record candidate to appear — it opens
    // that feature, so it is gated like any other (base's gate() kill-switches it).
    const sections = buildPaletteSources({
      ...base,
      gate: gate({ disabledRemote: new Set(), isEnabled: () => true }),
      recordIdHint: '001000000000001AAA',
    });
    const record = sectionFor(sections, 'record');
    expect(record?.candidates[0]?.action).toEqual({
      kind: 'inspect-record',
      recordId: '001000000000001AAA',
    });
    // Record section leads the non-recent sections.
    expect(sections[0]?.category).toBe('record');
  });

  it('suppresses the record candidate when inspect-record is kill-switched/disabled (AC-3)', () => {
    // base's gate() kill-switches inspect-record; the record entry opens that same
    // feature, so it must be gated too — not a kill-switch bypass.
    const sections = buildPaletteSources({ ...base, recordIdHint: '001000000000001AAA' });
    expect(sectionFor(sections, 'record')).toBeUndefined();
  });

  it('does not mint an inspect candidate for a non-record hint', () => {
    const sections = buildPaletteSources({ ...base, recordIdHint: 'WorkflowSettings' });
    expect(sectionFor(sections, 'record')).toBeUndefined();
  });

  it('orders recents first, resolved against the pool and de-duped from home sections', () => {
    const sections = buildPaletteSources({ ...base, recents: ['setup:sfdt_tab_login_as', 'feature:soql-runner'] });
    expect(sections[0]?.category).toBe('recent');
    expect(sections[0]?.candidates.map((c) => c.id)).toEqual([
      'setup:sfdt_tab_login_as',
      'feature:soql-runner',
    ]);
    // The recent feature is not repeated in the Features section.
    expect(sectionFor(sections, 'feature')).toBeUndefined();
    // The recent setup link is removed from the Setup section.
    const setupIds = sectionFor(sections, 'setup')?.candidates.map((c) => c.id) ?? [];
    expect(setupIds).not.toContain('setup:sfdt_tab_login_as');
  });

  it('skips recents that are not present in the current context', () => {
    const sections = buildPaletteSources({ ...base, recents: ['feature:does-not-exist'] });
    expect(sectionFor(sections, 'recent')).toBeUndefined();
  });
});
