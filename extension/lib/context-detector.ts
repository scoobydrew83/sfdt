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

  // Compare Versions can load inside Flow Builder without a URL change,
  // so fall back to DOM probes.
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

// Order matters: Compare Flows shares its base URL with Flow Builder, so
// the compare check has to win when both could match.
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

// Source of truth for which features show on which page lives on each
// feature's manifest. content.ts inverts the manifests at boot and calls
// setContextSource(); getAvailableFeatures() reads back from there.
interface ContextSource {
  readonly map: Readonly<Record<Context, readonly string[]>>;
}

const EMPTY_MAP: Readonly<Record<Context, readonly string[]>> = {
  [CONTEXTS.SETUP_FLOWS]: [],
  [CONTEXTS.FLOW_DETAILS]: [],
  [CONTEXTS.FLOW_BUILDER]: [],
  [CONTEXTS.COMPARE_FLOWS]: [],
  [CONTEXTS.FLOW_TRIGGER_EXPLORER]: [],
  [CONTEXTS.SETUP_OTHER]: [],
  [CONTEXTS.NONE]: [],
};

let _source: ContextSource = { map: EMPTY_MAP };

export interface FeatureContextDecl {
  id: string;
  contexts: readonly Context[];
}

// Pure function — exported so tests can verify without touching module state.
export function buildContextToFeatures(
  manifests: readonly FeatureContextDecl[],
): Readonly<Record<Context, readonly string[]>> {
  const out: Record<Context, string[]> = {
    [CONTEXTS.SETUP_FLOWS]: [],
    [CONTEXTS.FLOW_DETAILS]: [],
    [CONTEXTS.FLOW_BUILDER]: [],
    [CONTEXTS.COMPARE_FLOWS]: [],
    [CONTEXTS.FLOW_TRIGGER_EXPLORER]: [],
    [CONTEXTS.SETUP_OTHER]: [],
    [CONTEXTS.NONE]: [],
  };
  for (const m of manifests) {
    for (const ctx of m.contexts) {
      out[ctx].push(m.id);
    }
  }
  return out;
}

export function setContextSource(map: Readonly<Record<Context, readonly string[]>>): void {
  _source = { map };
}

// The caller must still gate the result on `settings.features.<id>` and the
// kill-switch list before showing anything.
export function getAvailableFeatures(
  win: { location: { href: string } } = window,
  doc: Document = document,
): readonly string[] {
  return _source.map[detectContext(win, doc)] ?? [];
}

export function _resetContextSourceForTests(): void {
  _source = { map: EMPTY_MAP };
}
