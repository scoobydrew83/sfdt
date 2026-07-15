// Org Release Badge tests — a non-interactive pill in the Setup tab strip
// showing the org's Salesforce release + preview flag. We exercise both the
// pure text composer and the feature against a happy-dom tab bar with a mocked
// Salesforce API client.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  createOrgReleaseBadgeFeature,
  describeBadge,
  type BadgeData,
} from '../features/org-release-badge.js';
import { _clearSettingsCacheForTests, saveSettings, SettingsSchema } from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function resetDom(): void {
  document.body.replaceChildren();
  const tabBar = document.createElement('ul');
  tabBar.className = 'tabBarItems';
  document.body.appendChild(tabBar);
}

// A version list where 68 is the newest; GA at the pinned date is 67, so 68 = preview.
const PREVIEW_VERSIONS = [
  { version: '67.0', label: "Summer '26" },
  { version: '68.0', label: "Winter '27" },
];
const GA_VERSIONS = [
  { version: '66.0', label: "Spring '26" },
  { version: '67.0', label: "Summer '26" },
];

function fakeApi(over: Partial<Record<'apiGet' | 'query', unknown>> = {}): SalesforceApiClient {
  return {
    apiGet: over.apiGet ?? (async () => GA_VERSIONS),
    query:
      over.query ??
      (async () => ({
        records: [{ InstanceName: 'NA123', IsSandbox: false, OrganizationType: 'Developer Edition' }],
        totalSize: 1,
        done: true,
      })),
  } as unknown as SalesforceApiClient;
}

beforeEach(() => {
  _clearSettingsCacheForTests();
  resetDom();
});

describe('describeBadge', () => {
  const mk = (over: Partial<BadgeData>): BadgeData => ({ release: null, org: null, ...over });

  it('shows the release label and a GA (non-preview) badge', () => {
    const { text } = describeBadge(
      mk({ release: { release: "Summer '26", apiVersion: 67, preview: false } }),
    );
    expect(text).toBe("Summer '26");
  });

  it('adds a Preview marker for preview instances', () => {
    const { text } = describeBadge(
      mk({ release: { release: "Winter '27", apiVersion: 68, preview: true } }),
    );
    expect(text).toBe("Winter '27 · Preview");
  });

  it('adds a Sandbox marker from the org row', () => {
    const { text, title } = describeBadge(
      mk({
        release: { release: "Summer '26", apiVersion: 67, preview: false },
        org: { InstanceName: 'CS42', IsSandbox: true, OrganizationType: 'Developer Edition' },
      }),
    );
    expect(text).toBe("Summer '26 · Sandbox");
    expect(title).toContain('sandbox');
    expect(title).toContain('CS42');
    expect(title).toContain('GA release');
  });

  it('falls back to org type when the release could not be read', () => {
    const { text } = describeBadge(mk({ org: { OrganizationType: 'Enterprise Edition' } }));
    expect(text).toBe('Enterprise Edition');
  });
});

describe('org-release-badge feature', () => {
  it('injects a badge pill with the release text', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    const pill = document.querySelector('.sfdt-org-release-badge span');
    expect(pill?.textContent).toBe("Summer '26");
  });

  it('renders an amber pill for a preview instance', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({
      waitTimeoutMs: 0,
      api: fakeApi({ apiGet: async () => PREVIEW_VERSIONS }),
    });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>('.sfdt-org-release-badge span');
    expect(pill?.textContent).toBe("Winter '27 · Preview");
    expect(pill?.style.background).toBe('var(--sfdt-color-warning)'); // amber preview colour
  });

  it('renders nothing when neither release nor org can be read', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({
      waitTimeoutMs: 0,
      api: fakeApi({
        apiGet: async () => {
          throw new Error('no versions');
        },
        query: async () => {
          throw new Error('no org');
        },
      }),
    });
    await feature.init?.();
    expect(document.querySelector('.sfdt-org-release-badge')).toBeNull();
  });

  it('does not double-inject when init runs twice', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    await feature.refresh?.();
    expect(document.querySelectorAll('.sfdt-org-release-badge')).toHaveLength(1);
  });

  it('is absent when the feature is disabled', async () => {
    await saveSettings(SettingsSchema.parse({ features: { 'org-release-badge': false } }));
    const feature = createOrgReleaseBadgeFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    expect(document.querySelector('.sfdt-org-release-badge')).toBeNull();
  });

  it('removes the badge on teardown', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    expect(document.querySelector('.sfdt-org-release-badge')).not.toBeNull();
    await feature.teardown?.();
    expect(document.querySelector('.sfdt-org-release-badge')).toBeNull();
  });

  it('does not throw when the tab bar never appears', async () => {
    document.body.replaceChildren();
    await saveSettings(SettingsSchema.parse({}));
    const feature = createOrgReleaseBadgeFeature({ waitTimeoutMs: 5, api: fakeApi() });
    await expect(feature.init?.()).resolves.not.toThrow();
    expect(document.querySelector('.sfdt-org-release-badge')).toBeNull();
  });
});
