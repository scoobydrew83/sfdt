import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFieldCreatorFeature, _fieldCreatorTestApi } from '../features/field-creator.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const { formatApiName, mapFieldType } = _fieldCreatorTestApi();

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiGet: vi.fn(async () => ({ sobjects: [] })),
    apiRequest: vi.fn(async () => ({ id: '01I800000000001AAA' })),
    query: vi.fn(async () => ({ records: [] })),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
});

describe('field-creator — formatApiName & mapFieldType', () => {
  it('converts field labels to clean PascalCase developer names', () => {
    expect(formatApiName('My Custom Field')).toBe('MyCustomField');
    expect(formatApiName('  spaced   label  ')).toBe('SpacedLabel');
    expect(formatApiName('Special-Chars*&$ Label')).toBe('SpecialCharsLabel');
    expect(formatApiName('AlreadyPascal')).toBe('AlreadyPascal');
  });

  it('maps UI types to Tooling API Metadata types', () => {
    expect(mapFieldType('Checkbox')).toBe('Checkbox');
    expect(mapFieldType('LongTextArea')).toBe('LongTextArea');
    expect(mapFieldType('MultiselectPicklist')).toBe('MultiselectPicklist');
  });
});

describe('field-creator — UI flow & Tooling API deployment', () => {
  it('mounts, allows adding fields and deploys via Tooling API with FLS permissions', async () => {
    const mockSobjects = {
      sobjects: [
        { name: 'Contact', label: 'Contact', queryable: true, createable: true, updateable: true, keyPrefix: '003' },
      ],
    };

    const mockPermissionSets = {
      records: [
        { Id: '0PS800000000001AAA', Name: 'SystemAdministrator', Profile: { Name: 'System Administrator' } },
      ],
    };

    const api = fakeApi({
      apiGet: vi.fn(async () => mockSobjects) as any,
      query: vi.fn(async () => mockPermissionSets) as any,
      apiRequest: vi.fn(async (_method, url, _body) => {
        if (url.includes('/sobjects/FieldPermissions')) {
          return { id: '0PM800000000001AAA', success: true };
        }
        return { id: '01I800000000001AAA', success: true };
      }) as any,
    });

    const feature = createFieldCreatorFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    // Check overlay
    const overlay = document.querySelector('.sfut-field-creator-overlay');
    expect(overlay).not.toBeNull();

    // SObject selector
    const sobjSelect = document.querySelector('select') as HTMLSelectElement;
    expect(sobjSelect).not.toBeNull();
    sobjSelect.value = 'Contact';
    sobjSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    // Input Label to trigger name conversion
    const labelInput = document.querySelector('input[placeholder="Field Label..."]') as HTMLInputElement;
    expect(labelInput).not.toBeNull();
    labelInput.value = 'Test Status';
    labelInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 0));

    // Developer name should be auto-set to TestStatus
    const nameInput = document.querySelector('input[placeholder="Developer_Name"]') as HTMLInputElement;
    expect(nameInput).not.toBeNull();
    expect(nameInput.value).toBe('TestStatus');

    // Click FLS button to assign profile permissions
    const flsBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('FLS'));
    expect(flsBtn).not.toBeUndefined();
    flsBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    // FLS overlay check visible checkbox
    const flsOverlay = document.querySelector('input[type="checkbox"]');
    expect(flsOverlay).not.toBeNull();
    // Select all for Read
    const checkBoxes = document.querySelectorAll('input[type="checkbox"]');
    const readAllCheck = checkBoxes[0] as HTMLInputElement;
    readAllCheck.click();
    readAllCheck.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    // Click Save Permissions
    const saveFLSBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save Permissions');
    expect(saveFLSBtn).not.toBeUndefined();
    saveFLSBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Trigger deploy
    const deployBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Deploy Fields');
    expect(deployBtn).not.toBeUndefined();
    expect(deployBtn!.disabled).toBe(false);

    deployBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // Verify CustomField was POSTed to Tooling API
    expect(api.apiRequest).toHaveBeenCalledWith('POST', expect.stringContaining('/tooling/sobjects/CustomField'), expect.objectContaining({
      FullName: 'Contact.TestStatus__c',
      Metadata: expect.objectContaining({
        label: 'Test Status',
        type: 'Text',
        length: 255,
      }),
    }));

    // Verify FieldPermissions was POSTed to standard REST API
    expect(api.apiRequest).toHaveBeenCalledWith('POST', expect.stringContaining('/sobjects/FieldPermissions/'), expect.objectContaining({
      ParentId: '0PS800000000001AAA',
      SobjectType: 'Contact',
      Field: 'Contact.TestStatus__c',
      PermissionsRead: true,
    }));
  });

  it('applies required/unique/externalId for Text fields and normalizes a manually typed __c suffix', async () => {
    const mockSobjects = {
      sobjects: [
        { name: 'Contact', label: 'Contact', queryable: true, createable: true, updateable: true, keyPrefix: '003' },
      ],
    };

    const mockPermissionSets = {
      records: [
        { Id: '0PS800000000001AAA', Name: 'SystemAdministrator', Profile: { Name: 'System Administrator' } },
      ],
    };

    const api = fakeApi({
      apiGet: vi.fn(async () => mockSobjects) as any,
      query: vi.fn(async () => mockPermissionSets) as any,
      apiRequest: vi.fn(async () => ({ id: '01I800000000001AAA', success: true })) as any,
    });

    const feature = createFieldCreatorFeature({ api });
    await feature.onActivate?.();
    await new Promise((r) => setTimeout(r, 0));

    const sobjSelect = document.querySelector('select') as HTMLSelectElement;
    sobjSelect.value = 'Contact';
    sobjSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 0));

    // Type a label, then manually overwrite the developer name with a trailing __c
    const labelInput = document.querySelector('input[placeholder="Field Label..."]') as HTMLInputElement;
    labelInput.value = 'External Code';
    labelInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 0));

    const nameInput = document.querySelector('input[placeholder="Developer_Name"]') as HTMLInputElement;
    nameInput.value = 'ExternalCode__c';
    nameInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 0));

    // Open the Options modal and toggle Required, Unique, External ID
    const optBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Options'));
    optBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    const optModalCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    // Required, Unique, External ID checkboxes (Text exposes all three)
    expect(optModalCheckboxes.length).toBeGreaterThanOrEqual(3);
    optModalCheckboxes.forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new Event('change'));
    });

    const saveOptBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Save');
    saveOptBtn!.click();
    await new Promise((r) => setTimeout(r, 0));

    // Deploy
    const deployBtn = Array.from(document.querySelectorAll('button')).find(b => b.textContent === 'Deploy Fields');
    deployBtn!.click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The manually-typed __c must be normalized (no Name__c__c) and Text options applied
    expect(api.apiRequest).toHaveBeenCalledWith('POST', expect.stringContaining('/tooling/sobjects/CustomField'), expect.objectContaining({
      FullName: 'Contact.ExternalCode__c',
      Metadata: expect.objectContaining({
        type: 'Text',
        length: 255,
        required: true,
        unique: true,
        externalId: true,
      }),
    }));
  });
});
