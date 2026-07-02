import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';
import {
  createShowApiNamesFeature,
  getLongId,
  normalizeFieldLabel,
  buildLayoutLabelMap,
  buildObjectLabelMap,
  formatApexLiteral,
  buildInsertStatement,
  buildSoqlStatement,
  annotateFieldLabels,
  annotateHeader,
  clearAnnotations,
  type LabelMaps,
  type SObjectDescribe,
} from '../features/show-api-names.js';
import {
  _resetSettingsShapesForTests,
  _clearSettingsCacheForTests,
  patchSettings,
  registerSettingsShape,
} from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    query: vi.fn(),
    toolingQuery: vi.fn(),
    queryMore: vi.fn(),
    apiGet: vi.fn(async () => ({})),
    apiRequest: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function addFieldLabel(text: string): HTMLElement {
  const el = document.createElement('span');
  el.className = 'test-id__field-label-container slds-form-element__label';
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  clearBody();
});

describe('getLongId', () => {
  it('derives the 18-char id from a 15-char id', () => {
    // Block 0 '001A0' has an uppercase at position 3 → bits 8 → 'I'.
    expect(getLongId('001A0000004aaaa')).toBe('001A0000004aaaaIAA');
    // All-uppercase block → bits 31 → '5'.
    expect(getLongId('ABCDEabcdeABCDE')).toBe('ABCDEabcdeABCDE5A5');
  });

  it('maps lowercase-only ids to the AAA suffix', () => {
    expect(getLongId('001aaaaaaaaaaaa')).toBe('001aaaaaaaaaaaaAAA');
  });

  it('returns empty for short or empty input', () => {
    expect(getLongId('')).toBe('');
    expect(getLongId('001')).toBe('');
  });

  it('re-derives the suffix from the first 15 chars of an 18-char id', () => {
    expect(getLongId('001A0000004aaaaXXX')).toBe('001A0000004aaaaIAA');
  });
});

describe('label maps', () => {
  const layoutFixture = {
    layouts: [
      {
        detailLayoutSections: [
          {
            layoutRows: [
              {
                layoutItems: [
                  { label: 'Email', layoutComponents: [{ value: 'Email__c' }] },
                  { label: 'Phone', layoutComponents: [{ value: 'Phone' }] },
                ],
              },
              {
                layoutItems: [
                  { label: 'Email', layoutComponents: [{ value: 'Secondary_Email__c' }] },
                  { placeholder: true, label: 'Ghost', layoutComponents: [{ value: 'Nope__c' }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  it('keys duplicate labels by layout-order occurrence and skips placeholders', () => {
    const map = buildLayoutLabelMap(layoutFixture);
    expect(map.get('Email')).toEqual({ 1: 'Email__c', 2: 'Secondary_Email__c' });
    expect(map.get('Phone')).toEqual({ 1: 'Phone' });
    expect(map.has('Ghost')).toBe(false);
  });

  it('accepts the bare-layout response shape (no layouts[] wrapper)', () => {
    const bare = layoutFixture.layouts[0];
    const map = buildLayoutLabelMap(bare);
    expect(map.get('Email')).toEqual({ 1: 'Email__c', 2: 'Secondary_Email__c' });
  });

  it('object map only carries labels the layout does not', () => {
    const layoutMap = buildLayoutLabelMap(layoutFixture);
    const describe: SObjectDescribe = {
      fields: [
        { name: 'Email__c', label: 'Email', type: 'email' },
        { name: 'CreatedDate', label: 'Created Date', type: 'datetime' },
      ],
    };
    const objectMap = buildObjectLabelMap(describe, layoutMap);
    expect(objectMap.has('Email')).toBe(false);
    expect(objectMap.get('Created Date')).toBe('CreatedDate');
  });

  it('normalizes labels for lookup', () => {
    expect(normalizeFieldLabel('  Created   Date: *')).toBe('created date');
  });
});

describe('annotateFieldLabels / annotateHeader', () => {
  function maps(): LabelMaps {
    const layoutLabelMap = new Map<string, Record<number, string>>([
      ['Email', { 1: 'Email__c', 2: 'Secondary_Email__c' }],
    ]);
    const objectLabelMap = new Map<string, string>([['Created Date', 'CreatedDate']]);
    return { layoutLabelMap, objectLabelMap };
  }

  it('annotates duplicate labels in layout order and falls back to the object map', () => {
    addFieldLabel('Email');
    addFieldLabel('Email');
    addFieldLabel('Created Date:');
    addFieldLabel('Unknown Field');

    const count = annotateFieldLabels(document, maps());
    expect(count).toBe(3);

    const spans = Array.from(document.querySelectorAll('.sfdt-api-name')).map(
      (s) => s.textContent,
    );
    expect(spans).toEqual(['(Email__c)', '(Secondary_Email__c)', '(CreatedDate)']);
  });

  it('overflow occurrences reuse a remaining layout value', () => {
    addFieldLabel('Email');
    addFieldLabel('Email');
    addFieldLabel('Email');
    annotateFieldLabels(document, maps());
    const spans = document.querySelectorAll('.sfdt-api-name');
    expect(spans).toHaveLength(3);
    expect(spans[2]!.textContent).toBe('(Email__c)');
  });

  it('is idempotent — a second pass adds nothing (observer loop safety)', () => {
    addFieldLabel('Email');
    annotateFieldLabels(document, maps());
    annotateFieldLabels(document, maps());
    expect(document.querySelectorAll('.sfdt-api-name')).toHaveLength(1);
  });

  it('annotates the header with object API name + 18-char id, once', () => {
    const header = document.createElement('h1');
    header.className = 'entityNameTitle';
    header.textContent = 'Account';
    document.body.appendChild(header);

    annotateHeader(document, 'Account', '001A0000004aaaaIAA');
    annotateHeader(document, 'Account', '001A0000004aaaaIAA');

    const spans = header.querySelectorAll('.sfdt-api-name');
    expect(spans).toHaveLength(1);
    expect(spans[0]!.textContent).toBe('(Account) (001A0000004aaaaIAA)');
  });

  it('clearAnnotations removes every injected span', () => {
    addFieldLabel('Email');
    annotateFieldLabels(document, maps());
    clearAnnotations(document);
    expect(document.querySelectorAll('.sfdt-api-name')).toHaveLength(0);
  });
});

describe('formatApexLiteral / buildInsertStatement / buildSoqlStatement', () => {
  const describeFixture: SObjectDescribe = {
    fields: [
      { name: 'Id', label: 'Record ID', type: 'id', createable: false },
      { name: 'Name', label: 'Name', type: 'string', createable: true },
      { name: 'IsActive', label: 'Active', type: 'boolean', createable: true },
      { name: 'Amount', label: 'Amount', type: 'currency', createable: true },
      { name: 'CloseDate', label: 'Close Date', type: 'date', createable: true },
      { name: 'CreatedDate', label: 'Created Date', type: 'datetime', createable: false },
    ],
  };

  it('formats typed literals', () => {
    expect(formatApexLiteral('boolean', true)).toBe('true');
    expect(formatApexLiteral('currency', 42.5)).toBe('42.5');
    expect(formatApexLiteral('date', '2026-07-01')).toBe("'2026-07-01'");
    expect(formatApexLiteral('string', "O'Neil\nCo")).toBe("'O\\'Neil\\nCo'");
    expect(formatApexLiteral('string', null)).toBeNull();
  });

  it('builds insert from sorted createable populated fields only', () => {
    const record = {
      attributes: { type: 'Opportunity' },
      Id: '006A0000004aaaa',
      Name: "Big 'Deal'",
      IsActive: true,
      Amount: 100,
      CloseDate: null,
      CreatedDate: '2026-07-01T00:00:00Z',
    };
    const statement = buildInsertStatement('Opportunity', record, describeFixture);
    expect(statement).toBe(
      "insert new Opportunity(\n  Amount = 100,\n  IsActive = true,\n  Name = 'Big \\'Deal\\''\n);",
    );
  });

  it('returns null when no createable values exist', () => {
    const record = { attributes: {}, Id: '006A0000004aaaa', Name: null };
    expect(buildInsertStatement('Opportunity', record, describeFixture)).toBeNull();
  });

  it('builds SOQL over populated ∩ described fields with Id ensured', () => {
    const record = {
      attributes: {},
      Name: 'X',
      Amount: 1,
      NotDescribed: 'y',
    };
    const soql = buildSoqlStatement('Opportunity', record, describeFixture, '006A0000004aaaaIAA');
    expect(soql).toBe(
      "SELECT Id, Amount, Name FROM Opportunity WHERE Id = '006A0000004aaaaIAA' LIMIT 1",
    );
  });
});

describe('feature lifecycle', () => {
  function setUrl(url: string): void {
    window.history.replaceState({}, '', url);
  }

  // Features hold live MutationObservers on the shared document — tear each
  // one down after its test so it can't annotate a later test's DOM.
  const createdFeatures: ReturnType<typeof createShowApiNamesFeature>[] = [];
  function makeFeature(api: SalesforceApiClient): ReturnType<typeof createShowApiNamesFeature> {
    const feature = createShowApiNamesFeature({ api });
    createdFeatures.push(feature);
    return feature;
  }
  afterEach(async () => {
    for (const feature of createdFeatures.splice(0)) {
      await feature.teardown?.();
    }
  });

  function routedApi(): SalesforceApiClient {
    const apiGet = vi.fn(async (path: string) => {
      if (path.includes('/describe/layouts/')) {
        return {
          layouts: [
            {
              detailLayoutSections: [
                {
                  layoutRows: [
                    {
                      layoutItems: [
                        { label: 'Account Name', layoutComponents: [{ value: 'Name' }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        };
      }
      if (path.endsWith('/describe')) {
        return {
          fields: [
            { name: 'Name', label: 'Account Name', type: 'string', createable: true },
            { name: 'Id', label: 'Record ID', type: 'id', createable: false },
          ],
        };
      }
      // record fetch
      return { attributes: {}, Id: '001A0000004aaaa', Name: 'Acme', RecordTypeId: '012000000000001AAA' };
    });
    return fakeApi({ apiGet: apiGet as never });
  }

  function enableDisplaySetting(): Promise<unknown> {
    registerSettingsShape(
      'show-api-names',
      z.object({ showApiNames: z.boolean().default(false) }),
    );
    return patchSettings({
      featureSettings: { 'show-api-names': { showApiNames: true } },
    } as never);
  }

  it('init() annotates a record page when the display setting is on', async () => {
    setUrl('https://x.lightning.force.com/lightning/r/Account/001A0000004aaaa/view');
    await enableDisplaySetting();
    addFieldLabel('Account Name');
    const header = document.createElement('h1');
    header.className = 'entityNameTitle';
    document.body.appendChild(header);

    const feature = makeFeature(routedApi());
    await feature.init?.();

    const spans = Array.from(document.querySelectorAll('.sfdt-api-name')).map(
      (s) => s.textContent,
    );
    expect(spans).toContain('(Name)');
    expect(spans).toContain('(Account) (001A0000004aaaaIAA)');
  });

  it('init() does nothing when the display setting is off', async () => {
    setUrl('https://x.lightning.force.com/lightning/r/Account/001A0000004aaaa/view');
    addFieldLabel('Account Name');
    const api = routedApi();
    const feature = makeFeature(api);
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-api-name')).toHaveLength(0);
    expect(api.apiGet).not.toHaveBeenCalled();
  });

  it('init() bails off record pages', async () => {
    setUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
    await enableDisplaySetting();
    const api = routedApi();
    const feature = makeFeature(api);
    await feature.init?.();
    expect(api.apiGet).not.toHaveBeenCalled();
  });

  it('teardown() removes annotations and stops re-annotating on mutations', async () => {
    setUrl('https://x.lightning.force.com/lightning/r/Account/001A0000004aaaa/view');
    await enableDisplaySetting();
    addFieldLabel('Account Name');

    const feature = makeFeature(routedApi());
    await feature.init?.();
    expect(document.querySelectorAll('.sfdt-api-name').length).toBeGreaterThan(0);

    await feature.teardown?.();
    expect(document.querySelectorAll('.sfdt-api-name')).toHaveLength(0);

    // New label after teardown must stay unannotated (observer disconnected).
    addFieldLabel('Account Name');
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelectorAll('.sfdt-api-name')).toHaveLength(0);
  });

  it('onActivate() opens the panel with the toggle and copy buttons', async () => {
    setUrl('https://x.lightning.force.com/lightning/r/Account/001A0000004aaaa/view');
    const feature = makeFeature(routedApi());
    await feature.onActivate?.();

    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    const buttons = Array.from(overlay!.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons).toContain('Copy 18-char Id');
    expect(buttons).toContain('Copy Apex insert');
    expect(buttons).toContain('Copy SOQL');
  });

  it('copy buttons write to the clipboard', async () => {
    setUrl('https://x.lightning.force.com/lightning/r/Account/001A0000004aaaa/view');
    const written: string[] = [];
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText: vi.fn(async (t: string) => void written.push(t)) },
    });

    try {
      const feature = makeFeature(routedApi());
      await feature.onActivate?.();

      const idBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Copy 18-char Id',
      )!;
      idBtn.click();
      await new Promise((r) => setTimeout(r, 0));
      expect(written).toContain('001A0000004aaaaIAA');

      const soqlBtn = Array.from(document.querySelectorAll('button')).find(
        (b) => b.textContent === 'Copy SOQL',
      )!;
      soqlBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      expect(written.some((t) => t.startsWith('SELECT ') && t.includes('FROM Account'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
