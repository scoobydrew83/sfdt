export const CONTEXTS = {
  SETUP_FLOWS: 'setup_flows',
  FLOW_DETAILS: 'flow_details',
  FLOW_BUILDER: 'flow_builder',
  COMPARE_FLOWS: 'compare_flows',
  FLOW_TRIGGER_EXPLORER: 'flow_trigger_explorer',
  SETUP_OTHER: 'setup_other',
  RECORD_PAGE: 'record_page',
  // The standalone Workspace tab. No URL maps to it (detectContext never
  // returns WORKSPACE — the Workspace gives features a synthetic win that
  // reports a real Salesforce URL). The bucket exists so Workspace-only tools
  // can declare themselves and the options page can list them.
  WORKSPACE: 'workspace',
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

export function extractRecordContext(url: string): { recordId: string; sobjectName?: string } | null {
  try {
    const urlObj = new URL(url);
    const path = urlObj.pathname;

    const lightningPattern = /\/lightning\/r\/([a-zA-Z0-9_]+)\/([a-zA-Z0-9]{15,18})\/view/i;
    const match1 = lightningPattern.exec(url);
    if (match1) {
      return { sobjectName: match1[1], recordId: match1[2]! };
    }

    const lightningPatternNoSobject = /\/lightning\/r\/([a-zA-Z0-9]{15,18})\/view/i;
    const match2 = lightningPatternNoSobject.exec(url);
    if (match2) {
      return { recordId: match2[1]! };
    }

    const queryParamPattern = /[?&]id=([a-zA-Z0-9]{15,18})/i;
    const match3 = queryParamPattern.exec(urlObj.search || url);
    if (match3) {
      return { recordId: match3[1]! };
    }

    if (!path.startsWith('/lightning/') && !path.startsWith('/apex/') && !path.startsWith('/services/') && !path.startsWith('/setup/')) {
      const classicPattern = /^\/([a-zA-Z0-9]{15,18})(?:\/|$)/;
      const match4 = classicPattern.exec(path);
      if (match4 && !match4[1]?.startsWith('000')) {
        return { recordId: match4[1]! };
      }
    }
  } catch {
    // Ignore URL parse errors
  }
  return null;
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
  if (extractRecordContext(url)) return CONTEXTS.RECORD_PAGE;
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
  [CONTEXTS.RECORD_PAGE]: [],
  [CONTEXTS.WORKSPACE]: [],
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
    [CONTEXTS.RECORD_PAGE]: [],
    [CONTEXTS.WORKSPACE]: [],
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
