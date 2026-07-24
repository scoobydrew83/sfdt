// API Version Audit tests — an on-demand view (⚡ menu / command palette) showing
// org max API version + per-type ApiVersion histograms. No always-on Setup-strip
// pill. We exercise the pure aggregation/description helpers and the feature's
// onActivate → present-view flow against happy-dom with a mocked Salesforce API.

import { describe, it, expect, beforeEach } from 'vitest';
import { ORG_HEALTH_THRESHOLDS } from '@sfdt/flow-core';
import {
  createApiVersionAuditFeature,
  aggregateVersions,
  countBehind,
  describeAuditPill,
  _apiVersionAuditTestApi,
} from '../features/api-version-audit.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { PANEL_CLASS } = _apiVersionAuditTestApi();
const FLOOR = ORG_HEALTH_THRESHOLDS.minApiVersionFloor; // 45 at time of writing

// With no content root or workspace sink registered, present-view falls back to
// a modal mounted in document.body — so the audit body is queryable there.
function resetDom(): void {
  document.body.replaceChildren();
}

// Two GA versions; 67 is the org max.
const GA_VERSIONS = [
  { version: '66.0', label: "Spring '26" },
  { version: '67.0', label: "Summer '26" },
];

// Per-query rows keyed on the FROM object, each in that type's real Tooling
// name shape. 3 below-floor components total: one ApexClass at v40, one
// ApexTrigger at v44, one LWC at v41.
const TOOLING_ROWS: Record<string, Array<Record<string, unknown>>> = {
  ApexClass: [
    { Name: 'LegacyController', ApiVersion: 40 },
    { Name: 'AccountService', ApiVersion: 62 },
    { Name: 'ContactService', ApiVersion: 62 },
  ],
  ApexTrigger: [{ Name: 'AccountTrigger', ApiVersion: 44 }],
  Flow: [{ Definition: { DeveloperName: 'Onboarding_Flow' }, ApiVersion: 58 }],
  LightningComponentBundle: [
    { DeveloperName: 'oldCard', ApiVersion: 41 },
    { DeveloperName: 'contactList', ApiVersion: 62 },
  ],
  AuraDefinitionBundle: [{ DeveloperName: 'setStartUrl', ApiVersion: 62 }],
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
  resetDom();
});

/** Bucket literal helper — keeps the expectation tables readable. */
function bucket(version: number, ...names: string[]) {
  return { version, names };
}

describe('aggregateVersions', () => {
  it('groups by version, oldest first, skipping unusable rows', () => {
    expect(
      aggregateVersions([
        { Name: 'Zeta', ApiVersion: 62 },
        { Name: 'Legacy', ApiVersion: 40 },
        { Name: 'Alpha', ApiVersion: 62 },
        { Name: 'NoVersion', ApiVersion: null },
        {},
      ]),
    ).toEqual([bucket(40, 'Legacy'), bucket(62, 'Alpha', 'Zeta')]);
  });

  it('reads the name from each type-specific Tooling shape', () => {
    expect(
      aggregateVersions([
        { Name: 'ApexClassName', ApiVersion: 50 },
        { DeveloperName: 'lwcName', ApiVersion: 50 },
        { Definition: { DeveloperName: 'Flow_Name' }, ApiVersion: 50 },
      ]),
    ).toEqual([bucket(50, 'ApexClassName', 'Flow_Name', 'lwcName')]);
  });

  it('falls back to (unknown) when no usable name is present', () => {
    expect(aggregateVersions([{ ApiVersion: 50 }, { Name: '  ', ApiVersion: 50 }])).toEqual([
      bucket(50, '(unknown)', '(unknown)'),
    ]);
  });
});

describe('countBehind', () => {
  it('counts components strictly below the flow-core floor', () => {
    const types = [
      {
        label: 'Apex Classes',
        versions: [bucket(FLOOR - 5, 'A', 'B', 'C'), bucket(FLOOR, 'D'), bucket(62, 'E', 'F', 'G', 'H')],
      },
      { label: 'Flows', versions: [bucket(FLOOR - 1, 'I', 'J')] },
    ];
    expect(countBehind(types)).toBe(5);
  });
});

describe('describeAuditPill', () => {
  it('composes org max + behind count', () => {
    const { text, title } = describeAuditPill({
      release: { release: "Summer '26", apiVersion: 67, preview: false },
      types: [{ label: 'Apex Classes', versions: [bucket(40, 'A', 'B'), bucket(62, 'C', 'D', 'E', 'F', 'G')] }],
    });
    expect(text).toBe('API v67 · 2 behind');
    expect(title).toContain('Org max API v67');
    expect(title).toContain(`below v${FLOOR}`);
  });

  it('omits the behind part when nothing is below the floor', () => {
    const { text } = describeAuditPill({
      release: { release: "Summer '26", apiVersion: 67, preview: false },
      types: [{ label: 'Apex Classes', versions: [bucket(62, 'A', 'B', 'C', 'D', 'E')] }],
    });
    expect(text).toBe('API v67');
  });
});

describe('api-version-audit feature', () => {
  it('renders nothing until activated (no always-on pill)', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.init?.();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });

  it('onActivate opens a view with the org-max summary and histogram rows', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();

    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`);
    expect(panel).not.toBeNull();
    // Summary line reuses describeAuditPill: org max + below-floor count.
    expect(panel!.textContent).toContain('API v67 · 3 behind');
    // ApexClass v40+v62, ApexTrigger v44, Flow v58, LWC v41+v62, Aura v62 = 7 rows.
    expect(panel!.querySelectorAll(`.${PANEL_CLASS}-row`)).toHaveLength(7);
    const below = panel!.querySelectorAll('[data-below-floor="true"]');
    expect(below).toHaveLength(3); // v40 class + v44 trigger + v41 lwc
    expect(panel!.textContent).toContain("Org max: v67 — Summer '26");
    expect(panel!.textContent).not.toContain('(preview)');
  });

  it('covers Lightning Web Components and Aura alongside Apex and Flows', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
    expect(panel.textContent).toContain('Lightning Web Components');
    expect(panel.textContent).toContain('Aura Components');
    // The LWC bundle below the floor is named via DeveloperName.
    expect(panel.textContent).toContain('oldCard');
  });

  it('below-floor rows are collapsed disclosure buttons naming the components', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;

    const rows = [...panel.querySelectorAll<HTMLElement>('[data-below-floor="true"]')];
    expect(rows.map((r) => r.tagName)).toEqual(['BUTTON', 'BUTTON', 'BUTTON']);

    const apexRow = rows[0]!;
    expect(apexRow.getAttribute('aria-expanded')).toBe('false');
    expect(apexRow.getAttribute('aria-label')).toContain('1 component on API v40');
    expect(apexRow.getAttribute('aria-label')).toContain(`below the v${FLOOR} floor`);

    // aria-controls points at the (hidden) name list holding the real names.
    const list = panel.querySelector<HTMLElement>(`#${apexRow.getAttribute('aria-controls')}`)!;
    expect(list.hidden).toBe(true);
    expect([...list.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['LegacyController']);
  });

  it('clicking a below-floor row toggles its name list and aria-expanded', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
    const row = panel.querySelector<HTMLElement>('[data-below-floor="true"]')!;
    const list = panel.querySelector<HTMLElement>(`#${row.getAttribute('aria-controls')}`)!;

    row.click();
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(list.hidden).toBe(false);

    row.click();
    expect(row.getAttribute('aria-expanded')).toBe('false');
    expect(list.hidden).toBe(true);
  });

  it('on-floor rows are inert — no button, no name list', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
    const onFloor = [...panel.querySelectorAll<HTMLElement>(`.${PANEL_CLASS}-row`)].filter(
      (r) => r.dataset['belowFloor'] !== 'true',
    );
    expect(onFloor).toHaveLength(4); // v62 class, v58 flow, v62 lwc, v62 aura
    for (const row of onFloor) {
      expect(row.tagName).toBe('DIV');
      expect(row.hasAttribute('aria-expanded')).toBe(false);
    }
    // One list per below-floor row, and no more.
    expect(panel.querySelectorAll(`.${PANEL_CLASS}-names`)).toHaveLength(3);
  });

  it('gives each name list a unique id so aria-controls never collides', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    const panel = document.querySelector<HTMLElement>(`.${PANEL_CLASS}`)!;
    const ids = [...panel.querySelectorAll(`.${PANEL_CLASS}-names`)].map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every(Boolean)).toBe(true);
  });

  it('still renders Apex/Trigger when the Flow query fails', async () => {
    const feature = createApiVersionAuditFeature({
      api: fakeApi({
        toolingQuery: async (soql: string) => {
          if (soql.includes('FROM Flow')) throw new Error('INVALID_TYPE');
          const type = /FROM (\w+)/.exec(soql)?.[1] ?? '';
          const records = TOOLING_ROWS[type] ?? [];
          return { records, size: records.length, done: true };
        },
      }),
    });
    await feature.onActivate?.();
    const panelText = document.querySelector(`.${PANEL_CLASS}`)?.textContent ?? '';
    expect(panelText).toContain('Apex Classes');
    expect(panelText).toContain('Apex Triggers');
    expect(panelText).not.toContain('Flows');
  });

  it('marks preview releases in the footer', async () => {
    const feature = createApiVersionAuditFeature({
      api: fakeApi({
        apiGet: async () => [
          { version: '67.0', label: "Summer '26" },
          { version: '68.0', label: "Winter '27" },
        ],
      }),
    });
    await feature.onActivate?.();
    expect(document.querySelector(`.${PANEL_CLASS}`)?.textContent).toContain(
      "Org max: v68 — Winter '27 (preview)",
    );
  });

  it('renders nothing when every fetch fails', async () => {
    const feature = createApiVersionAuditFeature({
      api: fakeApi({
        apiGet: async () => {
          throw new Error('no versions');
        },
        toolingQuery: async () => {
          throw new Error('no tooling');
        },
      }),
    });
    await feature.onActivate?.();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });

  it('teardown closes an open view', async () => {
    const feature = createApiVersionAuditFeature({ api: fakeApi() });
    await feature.onActivate?.();
    expect(document.querySelector(`.${PANEL_CLASS}`)).not.toBeNull();
    await feature.teardown?.();
    expect(document.querySelector(`.${PANEL_CLASS}`)).toBeNull();
  });
});
