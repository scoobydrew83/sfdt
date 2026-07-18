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
    expect(panel!.textContent).toContain('API v67 · 2 behind');
    // ApexClass v40+v62, ApexTrigger v44, Flow v58 = 4 histogram rows.
    expect(panel!.querySelectorAll(`.${PANEL_CLASS}-row`)).toHaveLength(4);
    const below = panel!.querySelectorAll('[data-below-floor="true"]');
    expect(below).toHaveLength(2); // v40 class + v44 trigger
    expect(panel!.textContent).toContain("Org max: v67 — Summer '26");
    expect(panel!.textContent).not.toContain('(preview)');
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
