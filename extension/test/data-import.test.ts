import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDataImportFeature, _dataImportTestApi } from '../features/data-import.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { csvParse, detectSeparator } = _dataImportTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiGet: vi.fn(async () => ({ sobjects: [] })),
    apiSoap: vi.fn(async () => []),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
});

describe('data-import — csvParse', () => {
  it('parses standard unquoted CSV/TSV', () => {
    const csv = 'Name,Email,Phone\nJohn,john@example.com,12345\nJane,jane@example.com,67890';
    const parsed = csvParse(csv, ',');
    expect(parsed).toEqual([
      ['Name', 'Email', 'Phone'],
      ['John', 'john@example.com', '12345'],
      ['Jane', 'jane@example.com', '67890'],
    ]);
  });

  it('parses quoted values with commas and escaped quotes', () => {
    const csv = 'Name,Description\n"John ""The Boss"" Doe","He lives in London, UK"\n"Jane","Plain"';
    const parsed = csvParse(csv, ',');
    expect(parsed).toEqual([
      ['Name', 'Description'],
      ['John "The Boss" Doe', 'He lives in London, UK'],
      ['Jane', 'Plain'],
    ]);
  });

  it('throws on mismatched cell counts', () => {
    const csv = 'A,B\n1,2\n1,2,3';
    expect(() => csvParse(csv, ',')).toThrow(/Row 3 has 3 cells, expected 2/);
  });

  it('ignores trailing empty rows from trailing newlines', () => {
    const csv = 'Name,Email\nJohn,john@example.com\nJane,jane@example.com\n\n';
    const parsed = csvParse(csv, ',');
    expect(parsed).toEqual([
      ['Name', 'Email'],
      ['John', 'john@example.com'],
      ['Jane', 'jane@example.com'],
    ]);
  });

  it('detects separators correctly', () => {
    expect(detectSeparator('A\tB\tC\n1\t2\t3')).toBe('\t');
    expect(detectSeparator('A,B,C\n1,2,3')).toBe(',');
    expect(detectSeparator('A;B;C\n1;2;3')).toBe(';');
  });
});

describe('data-import — UI Flow & Mock SOAP', () => {
  it('opens wizard, populates SObjects and executes import', async () => {
    const mockSobjects = {
      sobjects: [
        { name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true, keyPrefix: '001' },
        { name: 'Contact', label: 'Contact', queryable: true, createable: true, updateable: true, keyPrefix: '003' },
      ],
    };

    const mockDescribe = {
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Id', label: 'ID', type: 'id', updateable: false, createable: false, idLookup: true, externalId: false, soapType: 'tns:ID' },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, createable: true, idLookup: false, externalId: false, soapType: 'xsd:string' },
      ],
    };

    const api = fakeApi({
      apiGet: vi.fn(async (url: string) => {
        if (url.includes('/describe')) return mockDescribe;
        return mockSobjects;
      }) as any,
      apiSoap: vi.fn(async () => [
        { success: 'true', id: '001800000000001AAA' },
        { success: 'true', id: '001800000000002AAA' },
      ]) as any,
    });

    const feature = createDataImportFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    // Wizard is loaded, check DOM
    const overlay = document.querySelector('.sfdt-view-overlay');
    expect(overlay).not.toBeNull();

    // Pasting data
    const pasteArea = document.querySelector('textarea') as HTMLTextAreaElement;
    expect(pasteArea).not.toBeNull();
    pasteArea.value = 'Name\nTest Account 1\nTest Account 2';
    pasteArea.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 0));

    // Choose SObject Account
    const select = document.querySelector('select') as HTMLSelectElement;
    expect(select).not.toBeNull();
    select.value = 'Account';
    select.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    // Start Import button
    const buttons = document.querySelectorAll('button');
    const importBtn = Array.from(buttons).find(b => b.textContent === 'Start Import');
    expect(importBtn).not.toBeUndefined();
    expect(importBtn!.disabled).toBe(false);

    importBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify SOAP call is made and statuses are updated
    expect(api.apiSoap).toHaveBeenCalledWith('Partner', 'create', expect.objectContaining({
      sObjects: [
        { '$xsi:type': 'Account', Name: 'Test Account 1', fieldsToNull: [] },
        { '$xsi:type': 'Account', Name: 'Test Account 2', fieldsToNull: [] },
      ],
    }));

    const succeededCell = Array.from(document.querySelectorAll('span')).find(s => s.textContent?.includes('Succeeded: 2'));
    expect(succeededCell).not.toBeUndefined();
  });

  it('keeps import disabled for delete until an Id column is mapped, then sends mapped Ids', async () => {
    const mockSobjects = {
      sobjects: [
        { name: 'Account', label: 'Account', queryable: true, createable: true, updateable: true, keyPrefix: '001' },
      ],
    };

    const mockDescribe = {
      name: 'Account',
      label: 'Account',
      fields: [
        { name: 'Id', label: 'ID', type: 'id', updateable: false, createable: false, idLookup: true, externalId: false, soapType: 'tns:ID' },
        { name: 'Name', label: 'Account Name', type: 'string', updateable: true, createable: true, idLookup: false, externalId: false, soapType: 'xsd:string' },
      ],
    };

    const api = fakeApi({
      apiGet: vi.fn(async (url: string) => {
        if (url.includes('/describe')) return mockDescribe;
        return mockSobjects;
      }) as any,
      apiSoap: vi.fn(async () => [
        { success: 'true', id: '001800000000001AAA' },
      ]) as any,
    });

    const feature = createDataImportFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    // Paste data with a non-Id header so auto-guess maps "Name" but not "Id"
    const pasteArea = document.querySelector('textarea') as HTMLTextAreaElement;
    pasteArea.value = 'Name\nSome Account';
    pasteArea.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 0));

    // Choose Account
    const sobjSelect = document.querySelector('select') as HTMLSelectElement;
    sobjSelect.value = 'Account';
    sobjSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    // Switch operation to Delete
    const opSelect = Array.from(document.querySelectorAll('select')).find(
      (s) => Array.from(s.options).some((o) => o.value === 'delete'),
    ) as HTMLSelectElement;
    opSelect.value = 'delete';
    opSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    const importBtn = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent === 'Start Import',
    ) as HTMLButtonElement;
    // No Id mapped yet -> disabled
    expect(importBtn.disabled).toBe(true);

    // Map the "Name" column's mapping select to "Id".
    // Mapping selects are the only ones with a "Skip field" (empty-value) option.
    const mappingSelect = Array.from(document.querySelectorAll('select')).find(
      (s) =>
        Array.from(s.options).some((o) => o.value === 'Id') &&
        Array.from(s.options).some((o) => o.value === ''),
    ) as HTMLSelectElement;
    mappingSelect.value = 'Id';
    mappingSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    expect(importBtn.disabled).toBe(false);

    importBtn.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Id column index is derived from columnMappings, so the mapped cell value is sent
    expect(api.apiSoap).toHaveBeenCalledWith('Partner', 'delete', expect.objectContaining({
      ID: ['Some Account'],
    }));
  });
});
