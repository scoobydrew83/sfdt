import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CONTEXTS,
  detectContext,
  getAvailableFeatures,
  shouldShowSideButton,
  buildContextToFeatures,
  setContextSource,
  _resetContextSourceForTests,
  type Context,
} from '../lib/context-detector.js';
function fakeWin(url: string): { location: { href: string } } {
  return { location: { href: url } };
}
function emptyDoc(): Document {
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
    beforeEach(() => {
      setContextSource(
        buildContextToFeatures([
          {
            id: 'setup-tabs',
            contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
          },
          { id: 'flow-list-search', contexts: [CONTEXTS.SETUP_FLOWS] },
          { id: 'scheduled-flow-explorer', contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER] },
          {
            id: 'trigger-conflicts',
            contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
          },
          { id: 'subflow-graph', contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER] },
          { id: 'flow-version-manager', contexts: [CONTEXTS.FLOW_DETAILS] },
          { id: 'canvas-search', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'missing-descriptions', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'ai-assistant', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'api-name-generator', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'flow-health-check', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'flow-deploy', contexts: [CONTEXTS.FLOW_BUILDER] },
          { id: 'comparison-exporter', contexts: [CONTEXTS.COMPARE_FLOWS] },
          {
            id: 'flow-trigger-explorer-enhancer',
            contexts: [CONTEXTS.FLOW_TRIGGER_EXPLORER],
          },
        ]),
      );
    });
    afterEach(() => {
      _resetContextSourceForTests();
    });
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
  describe('buildContextToFeatures', () => {
    it('inverts feature manifests into a context-keyed map', () => {
      const result = buildContextToFeatures([
        { id: 'setup-tabs', contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.SETUP_OTHER] },
        { id: 'canvas-search', contexts: [CONTEXTS.FLOW_BUILDER] },
        { id: 'flow-list-search', contexts: [CONTEXTS.SETUP_FLOWS] },
      ]);
      expect(result[CONTEXTS.SETUP_FLOWS]).toEqual(['setup-tabs', 'flow-list-search']);
      expect(result[CONTEXTS.FLOW_BUILDER]).toEqual(['canvas-search']);
      expect(result[CONTEXTS.SETUP_OTHER]).toEqual(['setup-tabs']);
      expect(result[CONTEXTS.NONE]).toEqual([]);
    });
    it('preserves declaration order across features within one context', () => {
      const result = buildContextToFeatures([
        { id: 'first', contexts: [CONTEXTS.SETUP_FLOWS] },
        { id: 'second', contexts: [CONTEXTS.SETUP_FLOWS] },
        { id: 'third', contexts: [CONTEXTS.SETUP_FLOWS] },
      ]);
      expect(result[CONTEXTS.SETUP_FLOWS]).toEqual(['first', 'second', 'third']);
    });
  });
  describe('byte-for-byte parity with v2.0.2 routing', () => {
    const FROZEN: Readonly<Record<Context, readonly string[]>> = {
      [CONTEXTS.SETUP_FLOWS]: [
        'setup-tabs',
        'flow-list-search',
        'scheduled-flow-explorer',
        'trigger-conflicts',
        'subflow-graph',
      ],
      [CONTEXTS.FLOW_DETAILS]: ['flow-version-manager'],
      [CONTEXTS.FLOW_BUILDER]: [
        'canvas-search',
        'missing-descriptions',
        'ai-assistant',
        'api-name-generator',
        'flow-health-check',
        'flow-deploy',
      ],
      [CONTEXTS.COMPARE_FLOWS]: ['comparison-exporter'],
      [CONTEXTS.FLOW_TRIGGER_EXPLORER]: [
        'setup-tabs',
        'flow-trigger-explorer-enhancer',
        'trigger-conflicts',
      ],
      [CONTEXTS.SETUP_OTHER]: [
        'setup-tabs',
        'scheduled-flow-explorer',
        'trigger-conflicts',
        'subflow-graph',
      ],
      [CONTEXTS.NONE]: [],
    };
    it('reconstructs the frozen map from real feature manifest declarations', async () => {
      const factories = [
        await import('../features/setup-tabs.js').then((m) => m.createSetupTabsFeature),
        await import('../features/canvas-search.js').then((m) => m.createCanvasSearchFeature),
        await import('../features/flow-list-search.js').then((m) => m.createFlowListSearchFeature),
        await import('../features/missing-description-flags.js').then(
          (m) => m.createMissingDescriptionFlagsFeature,
        ),
        await import('../features/flow-version-manager.js').then((m) => m.createFlowVersionManagerFeature),
        await import('../features/ai-assistant.js').then((m) => m.createAiAssistantFeature),
        await import('../features/scheduled-flow-explorer.js').then(
          (m) => m.createScheduledFlowExplorerFeature,
        ),
        await import('../features/api-name-generator.js').then((m) => m.createApiNameGeneratorFeature),
        await import('../features/flow-health-check.js').then((m) => m.createFlowHealthCheckFeature),
        await import('../features/comparison-exporter.js').then((m) => m.createComparisonExporterFeature),
        await import('../features/flow-trigger-explorer-enhancer.js').then(
          (m) => m.createFlowTriggerExplorerEnhancerFeature,
        ),
        await import('../features/trigger-conflicts.js').then((m) => m.createTriggerConflictsFeature),
        await import('../features/subflow-graph.js').then((m) => m.createSubflowGraphFeature),
        await import('../features/flow-deploy.js').then((m) => m.createFlowDeployFeature),
      ];
      const manifests = factories.map((f) => f().manifest);
      expect(buildContextToFeatures(manifests)).toEqual(FROZEN);
    });
  });
});
