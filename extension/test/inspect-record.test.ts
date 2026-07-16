import { describe, it, expect, beforeEach, vi } from 'vitest';
import { extractRecordContext } from '../lib/context-detector.js';
import {
  createInspectRecordFeature,
  _inspectRecordTestApi,
} from '../features/inspect-record.js';
import { _resetSettingsShapesForTests, _clearSettingsCacheForTests } from '../lib/settings.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { getIconForType, isRecordId } = _inspectRecordTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
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

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  clearBody();
});

describe('inspect-record — context parser & helpers', () => {
  describe('extractRecordContext', () => {
    it('parses standard Lightning record URLs', () => {
      const url = 'https://mydomain.lightning.force.com/lightning/r/Account/001800000000001AAA/view';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ sobjectName: 'Account', recordId: '001800000000001AAA' });
    });

    it('parses Lightning URLs without SObject names', () => {
      const url = 'https://mydomain.lightning.force.com/lightning/r/001800000000001AAA/view';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('parses ID query parameter from URL', () => {
      const url = 'https://mydomain.lightning.force.com/apex/CustomPage?id=001800000000001AAA';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('parses Classic ID path structure', () => {
      const url = 'https://mydomain.my.salesforce.com/001800000000001AAA';
      const ctx = extractRecordContext(url);
      expect(ctx).toEqual({ recordId: '001800000000001AAA' });
    });

    it('ignores non-salesforce / non-record URLs', () => {
      expect(extractRecordContext('https://google.com')).toBeNull();
      expect(extractRecordContext('https://mydomain.lightning.force.com/lightning/setup/Flows/home')).toBeNull();
    });
  });

  describe('isRecordId', () => {
    it('validates 15-to-18 character ID formats', () => {
      expect(isRecordId('001800000000001AAA')).toBe(true);
      expect(isRecordId('001800000000001')).toBe(true);
      expect(isRecordId('001')).toBe(false);
      expect(isRecordId('000800000000001AAA')).toBe(false); // standard prefix exclusions
      expect(isRecordId('abc')).toBe(false);
    });
  });

  describe('getIconForType', () => {
    it('returns custom emojis for SObject data types', () => {
      expect(getIconForType('id')).toBe('🔑');
      expect(getIconForType('reference')).toBe('🔍');
      expect(getIconForType('boolean')).toBe('🌗');
      expect(getIconForType('picklist')).toBe('📋');
      expect(getIconForType('string')).toBe('📝');
      expect(getIconForType('int')).toBe('🔢');
      expect(getIconForType('date')).toBe('📅');
      expect(getIconForType('unknown')).toBe('🔹');
    });
  });
});

describe('inspect-record — UI activation & inspection', () => {
  function setSalesforceUrl(url: string): void {
    window.history.replaceState({}, '', url);
  }

  it('renders records in search grid on activation', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Id', label: 'Record ID', type: 'id', updateable: false, relationshipName: null, referenceTo: [] },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
        { name: 'Phone', label: 'Phone Number', type: 'phone', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Id: '001800000000001AAA',
      Name: 'Acme Test Corp',
      Phone: '123-456-7890'
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const api = fakeApi({ apiGet: apiGetMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    // Flush promises
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify modal elements are shown
    const recordInfo = Array.from(
      document.querySelectorAll('.sfdt-view-overlay span'),
    ).find((s) => s.textContent?.includes('Account · 001800000000001AAA'));
    expect(recordInfo).toBeTruthy();

    const trs = document.querySelectorAll('tbody tr');
    expect(trs).toHaveLength(3);

    const values = Array.from(document.querySelectorAll('tbody tr td span')).map(span => span.textContent);
    expect(values).toContain('Acme Test Corp');
    expect(values).toContain('123-456-7890');
  });

  it('filters field lists dynamically', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Id', label: 'Record ID', type: 'id', updateable: false, relationshipName: null, referenceTo: [] },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
        { name: 'Phone', label: 'Phone Number', type: 'phone', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Id: '001800000000001AAA',
      Name: 'Acme Test Corp',
      Phone: null
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const api = fakeApi({ apiGet: apiGetMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(3);

    // Filter by 'Phone'
    const filterInput = document.querySelector('input[placeholder="Filter fields by label, API name, or value..."]') as HTMLInputElement;
    filterInput.value = 'Phone';
    filterInput.dispatchEvent(new Event('input'));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);

    // Hide null values
    const checkbox = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(document.querySelectorAll('tbody tr')).toHaveLength(0);
  });

  it('handles in-place editing and saves changes via PATCH', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/r/Account/001800000000001AAA/view');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }]
    });

    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account Label',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] }
      ]
    });

    const rowGetMock = vi.fn().mockResolvedValue({
      Name: 'Acme Test Corp'
    });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const apiRequestMock = vi.fn().mockResolvedValue({});

    const api = fakeApi({ apiGet: apiGetMock, apiRequest: apiRequestMock });
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Double-click value span to start edit
    const valSpan = document.querySelector('tbody tr td span') as HTMLSpanElement;
    valSpan.click();

    const input = document.querySelector('tbody tr td input[type="text"]') as HTMLInputElement;
    expect(input.style.display).not.toBe('none');

    // Change value and blur to finish editing
    input.value = 'New Corp Name';
    input.dispatchEvent(new Event('blur'));

    // Re-render and check dirty state
    const saveBar = Array.from(document.querySelectorAll('div')).find(div => div.textContent?.includes('Save Changes'));
    expect(saveBar?.style.display).toBe('flex');

    const saveBtn = Array.from(document.querySelectorAll('button')).find(btn => btn.textContent === 'Save Changes');
    saveBtn?.click();

    await new Promise((r) => setTimeout(r, 0));

    expect(apiRequestMock).toHaveBeenCalledWith(
      'PATCH',
      expect.stringContaining('/sobjects/Account/001800000000001AAA'),
      { Name: 'New Corp Name' }
    );
  });

  it('openFor loads a specific record Id (the context-menu path), ignoring the page URL', async () => {
    // Page is a plain Setup page — the context menu passes an explicit Id from a
    // right-clicked link, so openFor must load THAT record, not the page URL.
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');

    const globalMock = vi.fn().mockResolvedValue({
      sobjects: [{ name: 'Account', label: 'Account', keyPrefix: '001' }],
    });
    const describeMock = vi.fn().mockResolvedValue({
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, relationshipName: null, referenceTo: [] },
      ],
    });
    const rowGetMock = vi.fn().mockResolvedValue({ Name: 'Menu Corp' });

    const apiGetMock = vi.fn(async (path: string) => {
      if (path.includes('/sobjects/Account/describe')) return describeMock();
      if (path.includes('/sobjects/Account/001800000000001AAA')) return rowGetMock();
      if (path.includes('/sobjects/')) return globalMock();
      return {};
    });

    const feature = createInspectRecordFeature({ api: fakeApi({ apiGet: apiGetMock }) });
    await feature.openFor('001800000000001AAA', 'Account');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const recordInfo = Array.from(document.querySelectorAll('.sfdt-view-overlay span')).find(
      (s) => s.textContent?.includes('Account · 001800000000001AAA'),
    );
    expect(recordInfo).toBeTruthy();
    const values = Array.from(document.querySelectorAll('tbody tr td span')).map((s) => s.textContent);
    expect(values).toContain('Menu Corp');
  });

  it('opens an empty inspector with a blank ID input when the page is not a record', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
    const api = fakeApi();
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();
    // No record was auto-loaded, so the global describe / record fetch never ran.
    expect(api.apiGet).not.toHaveBeenCalled();
    const idInput = document.querySelector<HTMLInputElement>(
      'input[placeholder^="Paste Salesforce Record ID"]',
    );
    expect(idInput).not.toBeNull();
    expect(idInput!.value).toBe('');
  });

  it('warns and does not query when an invalid ID is submitted', async () => {
    setSalesforceUrl('https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
    const api = fakeApi();
    const feature = createInspectRecordFeature({ api });

    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const idInput = document.querySelector<HTMLInputElement>(
      'input[placeholder^="Paste Salesforce Record ID"]',
    )!;
    idInput.value = 'not-a-valid-id';
    const inspectBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Inspect',
    ) as HTMLButtonElement;
    inspectBtn.click();
    await new Promise((r) => setTimeout(r, 0));

    expect(document.querySelector('.sfdt-toast')?.textContent).toMatch(/valid 15 or 18 character/);
    expect(api.apiGet).not.toHaveBeenCalled();
  });
});
