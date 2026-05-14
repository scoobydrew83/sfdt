import { describe, it, expect } from 'vitest';
import {
  CONTEXTS,
  detectContext,
  getAvailableFeatures,
  shouldShowSideButton,
  type Context,
} from '../lib/context-detector.js';

function fakeWin(url: string): { location: { href: string } } {
  return { location: { href: url } };
}

function emptyDoc(): Document {
  // Reuse the real happy-dom document with a cleared body so the Compare
  // Versions DOM probes return null.
  document.body.replaceChildren();
  return document;
}

describe('extension/lib/context-detector', () => {
  describe('detectContext — URL-only paths', () => {
    const cases: Array<[string, Context]> = [
      ['https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=1', CONTEXTS.FLOW_BUILDER],
      [
        'https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=1&compareTargetFlowId=2',
        CONTEXTS.COMPARE_FLOWS,
      ],
      ['https://x.lightning.force.com/interaction_explorer/flowExplorer.app', CONTEXTS.FLOW_TRIGGER_EXPLORER],
      ['https://x.my.salesforce-setup.com/lightning/setup/Flows/page?address=%2F300', CONTEXTS.FLOW_DETAILS],
      [
        'https://x.my.salesforce.com/udd/FlowDefinition/viewFlowDefinition.apexp?id=300',
        CONTEXTS.FLOW_DETAILS,
      ],
      ['https://x.my.salesforce-setup.com/lightning/setup/Flows/home', CONTEXTS.SETUP_FLOWS],
      ['https://x.my.salesforce-setup.com/lightning/setup/SomethingElse/home', CONTEXTS.SETUP_OTHER],
      ['https://example.com/somewhere', CONTEXTS.NONE],
    ];
    it.each(cases)('%s → %s', (url, expected) => {
      expect(detectContext(fakeWin(url), emptyDoc())).toBe(expected);
    });
  });

  describe('detectContext — DOM-fallback paths', () => {
    it('detects Compare Flows via DOM probe even without compareTargetFlowId in the URL', () => {
      const doc = emptyDoc();
      const probe = doc.createElement('div');
      probe.setAttribute('data-testid', 'baseFlowCompareVersionSelect');
      doc.body.appendChild(probe);
      expect(
        detectContext(
          fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=1'),
          doc,
        ),
      ).toBe(CONTEXTS.COMPARE_FLOWS);
    });

    it('detects Flow Details via the legacy table id alone', () => {
      // The legacy VF inner frame is detected purely by the presence of a
      // `table.list#view:lists:versions` element — the URL inside the iframe
      // can be anything. Faithful to v2.0.2's `_isFlowDetails` semantics.
      const doc = emptyDoc();
      const table = doc.createElement('table');
      table.id = 'view:lists:versions';
      table.className = 'list';
      doc.body.appendChild(table);
      expect(
        detectContext(
          fakeWin('https://x.my.salesforce.com/setup/whatever'),
          doc,
        ),
      ).toBe(CONTEXTS.FLOW_DETAILS);
    });
  });

  describe('shouldShowSideButton', () => {
    it('returns false on a random non-Salesforce URL', () => {
      expect(shouldShowSideButton(fakeWin('https://example.com/'), emptyDoc())).toBe(false);
    });
    it('returns true on a Salesforce setup page', () => {
      expect(
        shouldShowSideButton(
          fakeWin('https://x.my.salesforce-setup.com/lightning/setup/Flows/home'),
          emptyDoc(),
        ),
      ).toBe(true);
    });
  });

  describe('getAvailableFeatures', () => {
    it('lists the Setup Flows feature set on the Flow list page', () => {
      expect(
        getAvailableFeatures(
          fakeWin('https://x.my.salesforce-setup.com/lightning/setup/Flows/home'),
          emptyDoc(),
        ),
      ).toEqual([
        'setup-tabs',
        'flow-list-search',
        'scheduled-flow-explorer',
        'trigger-conflicts',
        'subflow-graph',
      ]);
    });

    it('lists the Flow Builder feature set on the canvas', () => {
      expect(
        getAvailableFeatures(
          fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=1'),
          emptyDoc(),
        ),
      ).toEqual([
        'canvas-search',
        'missing-descriptions',
        'ai-assistant',
        'api-name-generator',
        'flow-health-check',
        'flow-deploy',
      ]);
    });

    it('returns empty array on a non-Salesforce URL', () => {
      expect(getAvailableFeatures(fakeWin('https://example.com/'), emptyDoc())).toEqual([]);
    });
  });
});
