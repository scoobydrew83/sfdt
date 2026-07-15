// API Version Audit tests — a click-to-open pill in the Setup tab strip
// showing org max API version + per-type ApiVersion histograms. We exercise
// the pure aggregation/description helpers and the feature against a
// happy-dom tab bar with a mocked Salesforce API client.

import { describe, it, expect, beforeEach } from 'vitest';
import { ORG_HEALTH_THRESHOLDS } from '@sfdt/flow-core';
import {
  createApiVersionAuditFeature,
  aggregateVersions,
  countBehind,
  describeAuditPill,
  _apiVersionAuditTestApi,
} from '../features/api-version-audit.js';
import { _clearSettingsCacheForTests, saveSettings, SettingsSchema } from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { AUDIT_CLASS, PANEL_CLASS } = _apiVersionAuditTestApi();
const FLOOR = ORG_HEALTH_THRESHOLDS.minApiVersionFloor; // 45 at time of writing

function resetDom(): void {
  document.body.replaceChildren();
  const tabBar = document.createElement('ul');
  tabBar.className = 'tabBarItems';
  document.body.appendChild(tabBar);
}

// Two GA versions; 67 is the org max.
const GA_VERSIONS = [
  { version: '66.0', label: "Spring '26" },
  { version: '67.0', label: "Summer '26" },
];

// Per-query rows keyed on the FROM object. 2 below-floor rows total: one
// ApexClass at v40 and one ApexTrigger at v44.
const TOOLING_ROWS: Record<string, Array<{ ApiVersion: number }>> = {
  ApexClass: [{ ApiVersion: 40 }, { ApiVersion: 62 }, { ApiVersion: 62 }],
  ApexTrigger: [{ ApiVersion: 44 }],
  Flow: [{ ApiVersion: 58 }],
};

function fakeApi(
  over: Partial<Record<'apiGet' | 'toolingQuery', unknown>> = {},
): SalesforceApiClient {
  return {
    apiGet: over.apiGet ?? (async () => GA_VERSIONS),
    toolingQuery:
      over.toolingQuery ??
      (async (soql: string) => {
        const type = /FROM (\w+)/.exec(soql)?.[1] ?? '';
        const records = TOOLING_ROWS[type] ?? [];
        return { records, size: records.length, done: true };
      }),
  } as unknown as SalesforceApiClient;
}

beforeEach(() => {
  _clearSettingsCacheForTests();
  resetDom();
});

describe('aggregateVersions', () => {
  it('groups by version, oldest first, skipping unusable rows', () => {
    expect(
      aggregateVersions([
        { ApiVersion: 62 },
        { ApiVersion: 40 },
        { ApiVersion: 62 },
        { ApiVersion: null },
        {},
      ]),
    ).toEqual([
      [40, 1],
      [62, 2],
    ]);
  });
});

describe('countBehind', () => {
  it('counts components strictly below the flow-core floor', () => {
    const types = [
      { label: 'Apex Classes', versions: [[FLOOR - 5, 3], [FLOOR, 1], [62, 4]] as const },
      { label: 'Flows', versions: [[FLOOR - 1, 2]] as const },
    ];
    expect(countBehind(types as never)).toBe(5);
  });
});

describe('describeAuditPill', () => {
  it('composes org max + behind count', () => {
    const { text, title } = describeAuditPill({
      release: { release: "Summer '26", apiVersion: 67, preview: false },
      types: [{ label: 'Apex Classes', versions: [[40, 2], [62, 5]] }],
    });
    expect(text).toBe('API v67 · 2 behind');
    expect(title).toContain('Org max API v67');
    expect(title).toContain(`below v${FLOOR}`);
  });

  it('omits the behind part when nothing is below the floor', () => {
    const { text } = describeAuditPill({
      release: { release: "Summer '26", apiVersion: 67, preview: false },
      types: [{ label: 'Apex Classes', versions: [[62, 5]] }],
    });
    expect(text).toBe('API v67');
  });
});

describe('api-version-audit feature', () => {
  it('injects an amber pill with org max and below-floor count', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`);
    expect(pill?.textContent).toBe('API v67 · 2 behind');
    expect(pill?.style.background).toBe('var(--sfdt-color-warning)'); // amber — components below floor
  });

  it('renders a neutral pill when nothing is below the floor', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({
      waitTimeoutMs: 0,
      api: fakeApi({
        toolingQuery: async () => ({ records: [{ ApiVersion: 62 }], size: 1, done: true }),
      }),
    });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`);
    expect(pill?.textContent).toBe('API v67');
    expect(pill?.style.background).toBe('var(--sfdt-color-text-muted)'); // neutral grey
  });

  it('still renders Apex/Trigger when the Flow query fails', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({
      waitTimeoutMs: 0,
      api: fakeApi({
        toolingQuery: async (soql: string) => {
          if (soql.includes('FROM Flow')) throw new Error('INVALID_TYPE');
          const type = /FROM (\w+)/.exec(soql)?.[1] ?? '';
          const records = TOOLING_ROWS[type] ?? [];
          return { records, size: records.length, done: true };
        },
      }),
    });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`);
    expect(pill?.textContent).toBe('API v67 · 2 behind');
    (pill as HTMLElement).click();
    const panelText = document.querySelector(`.${PANEL_CLASS}`)?.textContent ?? '';
    expect(panelText).toContain('Apex Classes');
    expect(panelText).toContain('Apex Triggers');
    expect(panelText).not.toContain('Flows');
  });

  it('click toggles a panel with histogram rows, below-floor rows highlighted', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`)!;

    pill.click();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`);
    expect(panel).not.toBeNull();
    // ApexClass v40+v62, ApexTrigger v44, Flow v58 = 4 histogram rows.
    const rows = panel!.querySelectorAll(`.${PANEL_CLASS}-row`);
    expect(rows).toHaveLength(4);
    const below = panel!.querySelectorAll('[data-below-floor="true"]');
    expect(below).toHaveLength(2); // v40 class + v44 trigger
    expect(panel!.textContent).toContain("Org max: v67 — Summer '26");
    expect(panel!.textContent).not.toContain('(preview)');

    // Second click closes.
    pill.click();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });

  it('closes the panel on a click outside the pill', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`)!;

    pill.click();
    expect(document.querySelector(`.${PANEL_CLASS}`)).not.toBeNull();

    // A click elsewhere on the page dismisses the floating panel.
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    outside.click();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });

  it('marks preview releases in the footer and closes on Escape', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({
      waitTimeoutMs: 0,
      api: fakeApi({
        apiGet: async () => [
          { version: '67.0', label: "Summer '26" },
          { version: '68.0', label: "Winter '27" },
        ],
      }),
    });
    await feature.init?.();
    const pill = document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`)!;
    pill.click();
    expect(document.querySelector(`.${PANEL_CLASS}`)?.textContent).toContain(
      "Org max: v68 — Winter '27 (preview)",
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });

  it('renders nothing when every fetch fails', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({
      waitTimeoutMs: 0,
      api: fakeApi({
        apiGet: async () => {
          throw new Error('no versions');
        },
        toolingQuery: async () => {
          throw new Error('no tooling');
        },
      }),
    });
    await feature.init?.();
    expect(document.querySelector(`.${AUDIT_CLASS}`)).toBeNull();
  });

  it('does not double-inject when init runs twice', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    await feature.refresh?.();
    expect(document.querySelectorAll(`.${AUDIT_CLASS}`)).toHaveLength(1);
  });

  it('is absent when the feature is disabled', async () => {
    await saveSettings(SettingsSchema.parse({ features: { 'api-version-audit': false } }));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    expect(document.querySelector(`.${AUDIT_CLASS}`)).toBeNull();
  });

  it('removes pill and panel on teardown', async () => {
    await saveSettings(SettingsSchema.parse({}));
    const feature = createApiVersionAuditFeature({ waitTimeoutMs: 0, api: fakeApi() });
    await feature.init?.();
    document.querySelector<HTMLElement>(`.${AUDIT_CLASS} span`)!.click();
    expect(document.querySelector(`.${PANEL_CLASS}`)).not.toBeNull();
    await feature.teardown?.();
    expect(document.querySelector(`.${AUDIT_CLASS}`)).toBeNull();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });
});
