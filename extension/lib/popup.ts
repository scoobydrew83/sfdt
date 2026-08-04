// State + rendering for the browser-action popup — the thin entry point users
// expect after installing. It shows, for the active tab: whether it's a
// Salesforce page, which org, whether the user has a live session for that org,
// and whether the local sfdt bridge is reachable — plus quick buttons and a
// version line.
//
// Split from the entrypoint (entrypoints/popup/main.ts) so the state machine
// and the DOM builder are unit-testable in happy-dom. Rendering is
// createElement + textContent only (zero innerHTML). Colours are --sfdt-*
// tokens, so the popup inherits any future theme (P0-2) automatically.

import { salesforceHostFromUrl } from './sf-tab.js';
import { mySalesforceHostname } from './hostname.js';
import { icon } from './icons.js';

export type SessionStatus = 'active' | 'logged-out';
export type BridgeStatus = 'connected' | 'disconnected';
export type DefaultSurface = 'modal' | 'panel';

export interface PopupState {
  isSalesforceTab: boolean;
  /** Whether `chrome.sidePanel` exists (Chrome yes, Firefox no) — gates the panel button. */
  hasSidePanel: boolean;
  /** The active tab's Salesforce host, or null on a non-Salesforce tab. */
  orgHost: string | null;
  /** null on a non-Salesforce tab — no session check is made there. */
  session: SessionStatus | null;
  /** null on a non-Salesforce tab — no bridge ping is made there. */
  bridge: BridgeStatus | null;
  /** User's preferred default tool surface — 'panel' promotes the side-panel button. */
  defaultSurface: DefaultSurface;
  version: string;
}

export interface PopupDeps {
  /** URL of the active tab (chrome.tabs.query in the entrypoint). */
  activeTabUrl: string | undefined;
  /** Whether `chrome.sidePanel` exists in this browser (Chrome yes, Firefox no). */
  hasSidePanel: boolean;
  /** User's preferred default tool surface (settings.defaultSurface). */
  defaultSurface: DefaultSurface;
  /** Extension version, from chrome.runtime.getManifest(). */
  version: string;
  /** Logged-in Salesforce org hosts (canonical my.salesforce.com), via worker. */
  listLoggedInHosts: () => Promise<string[]>;
  /** Whether the local sfdt bridge answered a ping (via worker). */
  pingBridge: () => Promise<boolean>;
}

/** Collapse any Salesforce hostname to its canonical my.salesforce.com identity. */
function canonicalHost(host: string): string {
  return mySalesforceHostname(host) ?? host;
}

/**
 * Build the popup state. On a non-Salesforce tab this makes ZERO API calls —
 * neither listLoggedInHosts nor pingBridge is invoked — and returns the
 * "not a Salesforce tab" state. On a Salesforce tab it derives session status
 * (does the worker report a live session for this org?) and bridge status.
 *
 * Session/bridge lookups are best-effort: a rejected lookup degrades to
 * logged-out / disconnected rather than throwing the popup open empty.
 */
export async function loadPopupState(deps: PopupDeps): Promise<PopupState> {
  const orgHost = salesforceHostFromUrl(deps.activeTabUrl);
  if (!orgHost) {
    return {
      isSalesforceTab: false,
      hasSidePanel: deps.hasSidePanel,
      orgHost: null,
      session: null,
      bridge: null,
      defaultSurface: deps.defaultSurface,
      version: deps.version,
    };
  }

  const [hosts, bridgeUp] = await Promise.all([
    deps.listLoggedInHosts().catch(() => [] as string[]),
    deps.pingBridge().catch(() => false),
  ]);

  const target = canonicalHost(orgHost);
  const hasSession = hosts.some((h) => canonicalHost(h.toLowerCase()) === target);

  return {
    isSalesforceTab: true,
    hasSidePanel: deps.hasSidePanel,
    orgHost,
    session: hasSession ? 'active' : 'logged-out',
    bridge: bridgeUp ? 'connected' : 'disconnected',
    defaultSurface: deps.defaultSurface,
    version: deps.version,
  };
}

export interface PopupHandlers {
  onOpenWorkspace: () => void;
  onOpenPanel: () => void;
  onOpenPalette: () => void;
  onOpenOptions: () => void;
}

// Status → dot CLASS. Was a token string set as an inline background; the
// colours now live with every other threshold colour in lib/ui-styles.ts.
const CLASS_FOR_STATUS: Record<SessionStatus | BridgeStatus, string> = {
  active: 'sfdt-ok',
  connected: 'sfdt-ok',
  'logged-out': 'sfdt-idle',
  disconnected: 'sfdt-idle',
};

/**
 * A labelled status row: a colour dot (decorative, aria-hidden) plus a text
 * label that carries the meaning — so status is never conveyed by colour alone
 * (a11y). The whole row gets role="status" so assistive tech reads it.
 */
function statusRow(
  doc: Document,
  label: string,
  value: string,
  colour: string,
): HTMLElement {
  const row = doc.createElement('div');
  row.className = 'sfdt-popup-status';
  row.setAttribute('role', 'status');

  const dot = doc.createElement('span');
  dot.className = `sfdt-popup-dot ${colour}`;
  dot.setAttribute('aria-hidden', 'true');

  const text = doc.createElement('span');
  text.className = 'sfdt-popup-status-text';
  const strong = doc.createElement('strong');
  strong.textContent = `${label}: `;
  text.appendChild(strong);
  text.appendChild(doc.createTextNode(value));

  row.appendChild(dot);
  row.appendChild(text);
  return row;
}

/**
 * A command row: icon + label, the whole row clickable. Replaces the stack of
 * full-width bordered buttons — four of those read as a form, not a launcher.
 *
 * `primary` keeps its meaning (the leading action, promoted per defaultSurface)
 * and keeps the `primary` class the tests and the ordering logic rely on; it now
 * shows as accent colour and weight rather than a filled block.
 */
function button(
  doc: Document,
  label: string,
  onClick: () => void,
  primary = false,
  iconName = 'grid',
): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = primary ? 'sfdt-nav-item sfdt-popup-btn primary' : 'sfdt-nav-item sfdt-popup-btn';
  b.appendChild(glyph(doc, iconName));
  const text = doc.createElement('span');
  text.className = 'sfdt-nav-label';
  text.textContent = label;
  b.appendChild(text);
  b.addEventListener('click', onClick);
  return b;
}

/** A decorative icon in the wrapper the component sheet expects. */
function glyph(doc: Document, name: string, size = 20): HTMLElement {
  const span = doc.createElement('span');
  span.className = 'sfdt-glyph';
  span.setAttribute('aria-hidden', 'true');
  span.appendChild(icon(name, size, doc));
  return span;
}

const SESSION_LABEL: Record<SessionStatus, string> = {
  active: 'signed in',
  'logged-out': 'not signed in',
};
const BRIDGE_LABEL: Record<BridgeStatus, string> = {
  connected: 'connected',
  disconnected: 'not running',
};

/**
 * Render the popup body into `root` for a given state. Rebuilds from scratch
 * (idempotent) so it can be called after the async state resolves.
 */
export function renderPopup(
  root: HTMLElement,
  state: PopupState,
  handlers: PopupHandlers,
  doc: Document = document,
): void {
  while (root.firstChild) root.removeChild(root.firstChild);

  const head = doc.createElement('div');
  // Shared with the ⚡ side menu (lib/ui-styles.ts). Both surfaces used to
  // declare this row's padding/border/gap independently and identically.
  head.className = 'sfdt-panel-head';
  head.appendChild(glyph(doc, 'bolt'));
  const heading = doc.createElement('h1');
  heading.id = 'sfdt-popup-title';
  heading.className = 'sfdt-panel-title';
  // The ⚡ moved into the icon beside it — two bolts side by side otherwise.
  heading.textContent = 'SFDT for Salesforce';
  head.appendChild(heading);
  root.appendChild(head);

  const body = doc.createElement('div');
  body.className = 'sfdt-popup-body';

  if (state.isSalesforceTab && state.orgHost) {
    const org = doc.createElement('div');
    org.className = 'sfdt-popup-org';
    const orgStrong = doc.createElement('strong');
    orgStrong.textContent = 'Org: ';
    org.appendChild(orgStrong);
    org.appendChild(doc.createTextNode(state.orgHost));
    body.appendChild(org);

    if (state.session) {
      body.appendChild(
        statusRow(doc, 'Session', SESSION_LABEL[state.session], CLASS_FOR_STATUS[state.session]),
      );
    }
    if (state.bridge) {
      body.appendChild(
        statusRow(doc, 'sfdt bridge', BRIDGE_LABEL[state.bridge], CLASS_FOR_STATUS[state.bridge]),
      );
    }
  } else {
    const notSf = doc.createElement('p');
    notSf.className = 'sfdt-popup-empty';
    notSf.textContent =
      'Not a Salesforce tab. Open a Salesforce org (Setup, a record, or Flow Builder) to use the on-page tools, or open the Workspace below.';
    body.appendChild(notSf);
  }

  root.appendChild(body);

  const actions = doc.createElement('div');
  actions.className = 'sfdt-popup-actions';
  // The docked side panel and the Workspace both host the same tools and both
  // work from any tab (bind-on-open, else an org picker). Which one leads is the
  // user's `defaultSurface` preference (P2-3 PR-2, behaviour C): when they prefer
  // the panel AND this browser has chrome.sidePanel (Chrome; Firefox uses the
  // native sidebar and has no button here), the panel is the primary action;
  // otherwise the Workspace leads as before.
  const panelPreferred = state.defaultSurface === 'panel' && state.hasSidePanel;
  if (panelPreferred) {
    actions.appendChild(button(doc, 'Open side panel', handlers.onOpenPanel, true, 'panel'));
    actions.appendChild(button(doc, 'Open Workspace', handlers.onOpenWorkspace, false, 'external'));
  } else {
    actions.appendChild(button(doc, 'Open Workspace', handlers.onOpenWorkspace, true, 'external'));
    if (state.hasSidePanel) {
      actions.appendChild(button(doc, 'Open side panel', handlers.onOpenPanel, false, 'panel'));
    }
  }
  // The palette (⚡ menu) only exists on a Salesforce page's content script.
  if (state.isSalesforceTab) {
    actions.appendChild(button(doc, 'Quick menu', handlers.onOpenPalette, false, 'search'));
  }
  root.appendChild(actions);

  // Settings + version pinned to the bottom edge, so the action list above can
  // grow without pushing the version off or leaving it floating mid-card.
  const foot = doc.createElement('div');
  foot.className = 'sfdt-popup-foot';
  const settings = button(doc, 'Settings', handlers.onOpenOptions, false, 'settings');
  settings.classList.add('sfdt-popup-settings');
  foot.appendChild(settings);
  const version = doc.createElement('div');
  version.className = 'sfdt-popup-version';
  version.textContent = `v${state.version}`;
  foot.appendChild(version);
  root.appendChild(foot);
}
