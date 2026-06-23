import { describe, it, expect, beforeEach } from 'vitest';
import {
  _missingDescriptionFlagsTestApi,
  createMissingDescriptionFlagsFeature,
  findElementsWithoutDescriptions,
} from '../features/missing-description-flags.js';

const { buildKeyIndex, flagCanvas, clearAllFlags } = _missingDescriptionFlagsTestApi();

describe('extension/features/missing-description-flags', () => {
  describe('findElementsWithoutDescriptions', () => {
    it('finds elements with empty/missing descriptions across types', () => {
      const missing = findElementsWithoutDescriptions({
        description: '',
        assignments: [{ name: 'A1', label: 'Set' }, { name: 'A2', label: 'Set 2', description: 'documented' }],
        decisions: [{ name: 'D1', description: '   ' }],
        variables: [{ name: 'V1' }, { name: 'V2', description: 'documented' }],
      });
      const names = missing.map((m) => m.name);
      expect(names).toContain('A1');
      expect(names).not.toContain('A2');
      expect(names).toContain('D1');
      expect(names).toContain('V1');
      expect(names).not.toContain('V2');
      // The flow-level entry is appended last.
      expect(missing.find((m) => m.isFlow)).toBeDefined();
    });

    it('walks orchestrator stage steps', () => {
      const missing = findElementsWithoutDescriptions({
        description: 'present',
        orchestratedStages: [
          {
            name: 'Stage1',
            description: 'present',
            stageSteps: [{ name: 'Step1', label: 'Step One' }],
          },
        ],
      });
      expect(missing.find((m) => m.name === 'Step1')).toBeDefined();
    });

    it('returns an empty array (apart from flow level) when everything has descriptions', () => {
      const missing = findElementsWithoutDescriptions({
        description: 'docs',
        assignments: [{ name: 'A', description: 'd' }],
      });
      expect(missing).toEqual([]);
    });
  });

  describe('buildKeyIndex + flagCanvas + clearAllFlags', () => {
    it('flags element cards whose label matches', () => {
      const card = document.createElement('div');
      card.className = 'element-card';
      const span = document.createElement('span');
      span.className = 'text-element-label';
      span.title = 'Set Owner';
      const base = document.createElement('div');
      base.className = 'base-card';
      card.appendChild(span);
      card.appendChild(base);
      document.body.replaceChildren(card);

      flagCanvas(document, [
        { name: 'set_owner', label: 'Set Owner', type: 'Assignment', isResource: false },
      ]);
      expect(card.querySelector('.sfdt-desc-flag')).not.toBeNull();

      clearAllFlags(document);
      expect(card.querySelector('.sfdt-desc-flag')).toBeNull();
    });

    it('strips orchestrator number prefixes when matching ("1. Stage")', () => {
      const card = document.createElement('div');
      card.className = 'element-card';
      const span = document.createElement('span');
      span.className = 'text-element-label';
      span.title = '1. Onboarding';
      const base = document.createElement('div');
      base.className = 'base-card';
      card.appendChild(span);
      card.appendChild(base);
      document.body.replaceChildren(card);

      flagCanvas(document, [
        { name: 'Onboarding', label: 'Onboarding', type: 'Stage', isResource: false },
      ]);
      expect(card.querySelector('.sfdt-desc-flag')).not.toBeNull();
    });

    it('builds case-insensitive lookup keys', () => {
      const index = buildKeyIndex([
        { name: 'X', label: 'My Element', type: 'Assignment', isResource: false },
      ]);
      expect(index.has('my element')).toBe(true);
      expect(index.has('x')).toBe(true);
    });
  });
});

describe('missing-description-flags teardown', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    chrome.storage.local.clear();
  });

  it('removes flag badges and stops the observer on teardown', async () => {
    // Inject a card with a matching element so flagCanvas can place a badge.
    const card = document.createElement('div');
    card.className = 'element-card';
    const span = document.createElement('span');
    span.className = 'text-element-label';
    span.title = 'Set Owner';
    const base = document.createElement('div');
    base.className = 'base-card';
    card.appendChild(span);
    card.appendChild(base);
    document.body.appendChild(card);

    flagCanvas(document, [
      { name: 'set_owner', label: 'Set Owner', type: 'Assignment', isResource: false },
    ]);
    expect(document.querySelector('.sfdt-desc-flag')).not.toBeNull();

    const feature = createMissingDescriptionFlagsFeature();
    // Teardown should clean up regardless of whether init ran.
    await feature.teardown?.();
    expect(document.querySelector('.sfdt-desc-flag')).toBeNull();
  });

  it('does not throw when called twice', async () => {
    const feature = createMissingDescriptionFlagsFeature();
    await feature.teardown?.();
    await expect(feature.teardown?.()).resolves.not.toThrow();
  });
});
