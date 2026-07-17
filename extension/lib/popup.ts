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

export type SessionStatus = 'active' | 'logged-out';
export type BridgeStatus = 'connected' | 'disconnected';

export interface PopupState {
  isSalesforceTab: boolean;
  /** The active tab's Salesforce host, or null on a non-Salesforce tab. */
  orgHost: string | null;
  /** null on a non-Salesforce tab — no session check is made there. */
  session: SessionStatus | null;
  /** null on a non-Salesforce tab — no bridge ping is made there. */
  bridge: BridgeStatus | null;
  version: string;
}

export interface PopupDeps {
  /** URL of the active tab (chrome.tabs.query in the entrypoint). */
  activeTabUrl: string | undefined;
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
      orgHost: null,
      session: null,
      bridge: null,
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
    orgHost,
    session: hasSession ? 'active' : 'logged-out',
    bridge: bridgeUp ? 'connected' : 'disconnected',
    version: deps.version,
  };
}

export interface PopupHandlers {
  onOpenWorkspace: () => void;
  onOpenPanel: () => void;
  onOpenPalette: () => void;
  onOpenOptions: () => void;
}

const TOKEN_FOR_STATUS: Record<SessionStatus | BridgeStatus, string> = {
  active: 'var(--sfdt-color-success)',
  connected: 'var(--sfdt-color-success)',
  'logged-out': 'var(--sfdt-color-text-icon)',
  disconnected: 'var(--sfdt-color-text-icon)',
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
  dot.className = 'sfdt-popup-dot';
  dot.style.background = colour;
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

function button(
  doc: Document,
  label: string,
  onClick: () => void,
  primary = false,
): HTMLButtonElement {
  const b = doc.createElement('button');
  b.type = 'button';
  b.className = primary ? 'sfdt-popup-btn primary' : 'sfdt-popup-btn';
  b.textContent = label;
  b.addEventListener('click', onClick);
  return b;
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

  const heading = doc.createElement('h1');
  heading.id = 'sfdt-popup-title';
  heading.className = 'sfdt-popup-title';
  heading.textContent = '⚡ SFDT SF Helper';
  root.appendChild(heading);

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
        statusRow(doc, 'Session', SESSION_LABEL[state.session], TOKEN_FOR_STATUS[state.session]),
      );
    }
    if (state.bridge) {
      body.appendChild(
        statusRow(doc, 'sfdt bridge', BRIDGE_LABEL[state.bridge], TOKEN_FOR_STATUS[state.bridge]),
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
  // Workspace works from any tab (it shows an org picker when there's no org),
  // so it's always offered and is the primary action.
  actions.appendChild(button(doc, 'Open Workspace', handlers.onOpenWorkspace, true));
  // The docked side panel hosts the same tools alongside the current tab. Like
  // the Workspace it works from any tab (bind-on-open, else an org picker).
  actions.appendChild(button(doc, 'Open side panel', handlers.onOpenPanel));
  // The palette (⚡ menu) only exists on a Salesforce page's content script.
  if (state.isSalesforceTab) {
    actions.appendChild(button(doc, 'Quick menu', handlers.onOpenPalette));
  }
  actions.appendChild(button(doc, 'Settings', handlers.onOpenOptions));
  root.appendChild(actions);

  const version = doc.createElement('div');
  version.className = 'sfdt-popup-version';
  version.textContent = `v${state.version}`;
  root.appendChild(version);
}
