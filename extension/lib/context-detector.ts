// Context detector — port of
// /Users/dkennedy/dev/2.0.2_0 copy/utils/context-detector.js.
//
// Inspects the current URL (and a couple of fallback DOM probes) to figure
// out which Salesforce page the user is on. Each context maps to a set of
// feature ids the side menu should expose.

export const CONTEXTS = {
  SETUP_FLOWS: 'setup_flows',
  FLOW_DETAILS: 'flow_details',
  FLOW_BUILDER: 'flow_builder',
  COMPARE_FLOWS: 'compare_flows',
  FLOW_TRIGGER_EXPLORER: 'flow_trigger_explorer',
  SETUP_OTHER: 'setup_other',
  NONE: 'none',
} as const;

export type Context = (typeof CONTEXTS)[keyof typeof CONTEXTS];

function isFlowBuilder(url: string): boolean {
  return url.includes('/builder_platform_interaction/flowBuilder.app');
}

function isCompareFlows(url: string, doc: Document): boolean {
  if (!isFlowBuilder(url)) return false;
  if (url.includes('compareTargetFlowId')) return true;

  // Fallback DOM probes for the Compare Versions view which can load inside
  // Flow Builder without a URL change.
  if (doc.querySelector('[data-testid="baseFlowCompareVersionSelect"]')) return true;
  if (doc.querySelector('[data-testid="secondaryFlowCompareVersionSelect"]')) return true;
  if (doc.querySelector('.test-flow-compare-panel')) return true;

  return Array.from(doc.querySelectorAll('button')).some(
    (b) => b.textContent?.trim() === 'Compare Versions' && b.closest('[class*="compare"]'),
  );
}

function isFlowTriggerExplorer(url: string): boolean {
  return (
    url.includes('/interaction_explorer/flowExplorer') || url.includes('FlowTriggerExplorer')
  );
}

function isFlowDetails(url: string, doc: Document): boolean {
  if (url.includes('lightning/setup/Flows/page')) return true;
  if (url.includes('/udd/FlowDefinition/viewFlowDefinition.apexp')) return true;
  return !!doc.querySelector('table.list[id="view:lists:versions"]');
}

function isSetupFlows(url: string): boolean {
  return url.includes('lightning/setup/Flows/home');
}

function isSetup(url: string): boolean {
  return url.includes('lightning/setup/');
}

/**
 * Detect the current Salesforce page context.
 *
 * Order matters: more specific checks come first. In particular, Compare
 * Flows shares its base URL with Flow Builder, so the compare check has to
 * win when both could match.
 */
export function detectContext(
  win: { location: { href: string } } = window,
  doc: Document = document,
): Context {
  const url = win.location.href;

  if (isCompareFlows(url, doc)) return CONTEXTS.COMPARE_FLOWS;
  if (isFlowBuilder(url)) return CONTEXTS.FLOW_BUILDER;
  if (isFlowTriggerExplorer(url)) return CONTEXTS.FLOW_TRIGGER_EXPLORER;
  if (isFlowDetails(url, doc)) return CONTEXTS.FLOW_DETAILS;
  if (isSetupFlows(url)) return CONTEXTS.SETUP_FLOWS;
  if (isSetup(url)) return CONTEXTS.SETUP_OTHER;
  return CONTEXTS.NONE;
}

export function shouldShowSideButton(
  win: { location: { href: string } } = window,
  doc: Document = document,
): boolean {
  return detectContext(win, doc) !== CONTEXTS.NONE;
}

const CONTEXT_TO_FEATURES: Record<Context, readonly string[]> = {
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

/**
 * Return the feature ids available for the current context. Combine with
 * `settings.features.<id>` and `registry.has(<id>)` in the caller to decide
 * what to actually show.
 */
export function getAvailableFeatures(
  win: { location: { href: string } } = window,
  doc: Document = document,
): readonly string[] {
  return CONTEXT_TO_FEATURES[detectContext(win, doc)];
}
