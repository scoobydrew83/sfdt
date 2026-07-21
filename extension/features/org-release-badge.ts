import { releaseFromVersionList, type OrgReleaseInfo } from '@sfdt/flow-core';
import { isFeatureEnabled, loadSettings, onSettingsChange } from '../lib/settings.js';
import type { Feature } from '../lib/feature-registry.js';
import { CONTEXTS } from '../lib/context-detector.js';
import { waitForTabBar } from '../lib/setup-tab-bar.js';
import { getSalesforceApi, type SalesforceApiClient } from '../lib/salesforce-api.js';

// A non-interactive pill in the Setup tab strip showing the org's Salesforce
// release + whether it's a preview instance. Mirrors the CLI's `monitor
// org-info` release detection (both derive it via flow-core so "preview" means
// the same thing everywhere). The Release Manager *channel* has no queryable
// API, so it's deliberately out of scope — version + preview only.

const BADGE_CLASS = 'sfdt-org-release-badge';
const PREVIEW_COLOUR = 'var(--sfdt-color-warning)'; // amber — matches org-health-live's preview/amber band
const GA_COLOUR = 'var(--sfdt-color-text-muted)'; // neutral grey

interface OrgRow {
  InstanceName?: string | null;
  IsSandbox?: boolean | null;
  OrganizationType?: string | null;
}

export interface BadgeData {
  release: OrgReleaseInfo | null;
  org: OrgRow | null;
}

/** Fetch release + org info; returns null only when neither could be read. */
async function fetchBadgeData(api: SalesforceApiClient): Promise<BadgeData | null> {
  let release: OrgReleaseInfo | null = null;
  try {
    // `/services/data` (unversioned) lists every supported API version + label.
    release = releaseFromVersionList(await api.apiGet('/services/data'));
  } catch {
    // Informational — a failed version list just drops the release half.
  }

  let org: OrgRow | null = null;
  try {
    const res = await api.query<OrgRow>(
      'SELECT InstanceName, IsSandbox, OrganizationType FROM Organization LIMIT 1',
    );
    org = res.records[0] ?? null;
  } catch {
    // Same — the badge still renders with whatever half succeeded.
  }

  if (!release && !org) return null;
  return { release, org };
}

/** Compose the short pill text + a longer hover title from the fetched data. */
export function describeBadge(data: BadgeData): { text: string; title: string } {
  const { release, org } = data;
  const sandbox = org?.IsSandbox === true;
  const label = release?.release ?? (org?.OrganizationType ? String(org.OrganizationType) : 'Salesforce');
  const parts = [label];
  if (release?.preview) parts.push('Preview');
  if (sandbox) parts.push('Sandbox');
  const text = parts.join(' · ');

  const titleBits: string[] = [];
  if (org?.OrganizationType) titleBits.push(String(org.OrganizationType) + (sandbox ? ' (sandbox)' : ''));
  if (org?.InstanceName) titleBits.push(`instance ${org.InstanceName}`);
  if (release) {
    titleBits.push(
      `newest API v${release.apiVersion} — ${release.preview ? 'preview instance' : 'GA release'}`,
    );
  }
  return { text, title: titleBits.join(' · ') || text };
}

function buildBadge(doc: Document, data: BadgeData): HTMLLIElement {
  const { text, title } = describeBadge(data);
  const li = doc.createElement('li');
  li.setAttribute('role', 'presentation');
  li.className = `oneConsoleTabItem tabItem slds-context-bar__item ${BADGE_CLASS}`;
  li.style.cssText = 'display: flex; align-items: center; padding: 0 8px;';

  const pill = doc.createElement('span');
  const preview = data.release?.preview === true;
  pill.style.cssText = [
    'font-size: 10px',
    'font-weight: 700',
    'text-transform: uppercase',
    'letter-spacing: 0.02em',
    'color: var(--sfdt-color-on-accent)',
    `background: ${preview ? PREVIEW_COLOUR : GA_COLOUR}`,
    'border-radius: 3px',
    'padding: 2px 8px',
    'white-space: nowrap',
  ].join('; ');
  pill.textContent = text;
  pill.title = title;

  li.appendChild(pill);
  return li;
}

function removeBadge(doc: Document): void {
  for (const el of doc.querySelectorAll(`.${BADGE_CLASS}`)) el.remove();
}

export interface OrgReleaseBadgeOptions {
  doc?: Document;
  win?: Window;
  api?: SalesforceApiClient;
  waitTimeoutMs?: number;
}

export function createOrgReleaseBadgeFeature(options: OrgReleaseBadgeOptions = {}): Feature {
  const doc = options.doc ?? document;
  const api = options.api ?? getSalesforceApi();
  const timeoutMs = options.waitTimeoutMs ?? 10_000;
  let injecting = false;
  let unsubscribe: (() => void) | null = null;
  // Release/instance don't change within a session — fetch once, reuse across
  // SPA navigations (each nav rebuilds the tab bar, so we re-inject the badge).
  let cached: BadgeData | null = null;

  async function injectIfEnabled(): Promise<void> {
    const settings = await loadSettings();
    if (!isFeatureEnabled(settings, 'org-release-badge')) {
      removeBadge(doc);
      return;
    }
    if (injecting) return;
    if (doc.querySelector(`.${BADGE_CLASS}`)) return;

    injecting = true;
    try {
      const tabBar = await waitForTabBar(doc, timeoutMs);
      if (!tabBar) return;
      if (doc.querySelector(`.${BADGE_CLASS}`)) return; // another pass mounted it while we waited

      cached ??= await fetchBadgeData(api);
      if (!cached) return;
      tabBar.appendChild(buildBadge(doc, cached));
    } catch (err) {
      console.warn('[SFDT org-release-badge] failed to render', err);
    } finally {
      injecting = false;
    }
  }

  return {
    manifest: {
      id: 'org-release-badge',
      name: 'Org Release Badge',
      contexts: [CONTEXTS.SETUP_FLOWS, CONTEXTS.FLOW_TRIGGER_EXPLORER, CONTEXTS.SETUP_OTHER],
    },

    async init() {
      await injectIfEnabled();
      unsubscribe = onSettingsChange(async () => {
        removeBadge(doc);
        await injectIfEnabled();
      });
    },

    async refresh() {
      removeBadge(doc);
      await injectIfEnabled();
    },

    async teardown() {
      unsubscribe?.();
      unsubscribe = null;
      removeBadge(doc);
    },
  };
}

export function _orgReleaseBadgeTestApi() {
  return { BADGE_CLASS };
}
