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
    const overlay = document.querySelector('.sfdt-view-overlay');
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

// ---------------------------------------------------------------------------
// Helpers shared by the logic-focused additions below. These drive the same
// DOM the production UI builds (the internal helpers — deploySingleField,
// openOptionsModal, openFLSModal — are not exported, so they're exercised
// through the rendered controls exactly as a user would).
// ---------------------------------------------------------------------------

const mockSobjects = {
  sobjects: [
    { name: 'Contact', label: 'Contact', queryable: true, createable: true, updateable: true, keyPrefix: '003' },
  ],
};

const mockPermissionSets = {
  records: [
    { Id: '0PS800000000001AAA', Name: 'Admin', Profile: { Name: 'System Administrator' } },
    // No Profile => treated as a standalone Permission Set
    { Id: '0PS800000000002AAA', Name: 'CustomPermSet' },
  ],
};

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

function mountFC(overrides: Partial<SalesforceApiClient> = {}) {
  const api = fakeApi({
    apiGet: vi.fn(async () => mockSobjects) as any,
    query: vi.fn(async () => mockPermissionSets) as any,
    apiRequest: vi.fn(async () => ({ id: '01I800000000001AAA', success: true })) as any,
    ...overrides,
  });
  const feature = createFieldCreatorFeature({ api });
  return { api, feature };
}

function btnIncludes(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined;
}
function btnExact(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text) as
    | HTMLButtonElement
    | undefined;
}

async function selectContactAndLabel(label = 'My Field'): Promise<void> {
  const sobj = document.querySelector('select') as HTMLSelectElement;
  sobj.value = 'Contact';
  sobj.dispatchEvent(new Event('change'));
  await flush();
  const labelInput = document.querySelector('input[placeholder="Field Label..."]') as HTMLInputElement;
  labelInput.value = label;
  labelInput.dispatchEvent(new Event('input'));
  await flush();
}

function setRowType(type: string): void {
  const selects = document.querySelectorAll('select');
  const typeSel = selects[1] as HTMLSelectElement; // [0] is the SObject selector
  typeSel.value = type;
  typeSel.dispatchEvent(new Event('change'));
}

async function openOptions(): Promise<void> {
  btnIncludes('Options')!.click();
  await flush();
}

async function deploy(): Promise<void> {
  btnExact('Deploy Fields')!.click();
  await flush();
  await flush();
}

describe('field-creator — formatApiName edge cases', () => {
  it('preserves leading digits (no reserved-word munging in source)', () => {
    expect(formatApiName('123 Field')).toBe('123Field');
  });
  it('strips special characters and collapses the gaps', () => {
    expect(formatApiName('field@#$name')).toBe('FieldName');
  });
  it('trims surrounding underscores produced by leading/trailing junk', () => {
    expect(formatApiName('___weird___')).toBe('Weird');
  });
  it('uppercases a single character', () => {
    expect(formatApiName('a')).toBe('A');
  });
  it('returns empty string for empty/whitespace input', () => {
    expect(formatApiName('')).toBe('');
    expect(formatApiName('   ')).toBe('');
  });
});

describe('field-creator — mapFieldType full table', () => {
  it('maps every known UI type to itself', () => {
    for (const t of [
      'Checkbox', 'Currency', 'Date', 'DateTime', 'Email', 'Location', 'Number',
      'Percent', 'Phone', 'Picklist', 'MultiselectPicklist', 'Text', 'TextArea',
      'LongTextArea', 'Html', 'Url',
    ]) {
      expect(mapFieldType(t)).toBe(t);
    }
  });
  it('falls through to the raw value for unknown types', () => {
    expect(mapFieldType('SomethingElse')).toBe('SomethingElse');
  });
});

describe('field-creator — row management & gating', () => {
  it('adds, clears, clones and deletes rows and keeps deploy gated until ready', async () => {
    const { feature } = mountFC();
    await feature.onActivate?.();
    await flush();

    const deployBtn = btnExact('Deploy Fields')!;
    expect(deployBtn.disabled).toBe(true); // no SObject yet

    // Add Field before selecting an object -> validateReady early-return path
    btnIncludes('Add Field')!.click();
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(deployBtn.disabled).toBe(true);

    // Clear All collapses back to a single empty row
    btnIncludes('Clear All')!.click();
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);

    // Deleting the only row re-seeds an empty row (never zero rows)
    (document.querySelector('td button[title="Delete field definition"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);

    // Now make it deployable and clone the row
    await selectContactAndLabel('Score');
    expect(deployBtn.disabled).toBe(false);
    (document.querySelector('td button[title="Clone field definition"]') as HTMLButtonElement).click();
    await flush();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(2);
  });
});

describe('field-creator — option modal + deploy request shape per type', () => {
  it('Number: precision/scale flow', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Amount');
    setRowType('Number');
    await openOptions();
    // Description is a free-text option input (exercises the text handler)
    const descRow = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Description');
    const descInput = descRow!.parentElement!.querySelector('input') as HTMLInputElement;
    descInput.value = 'how much';
    descInput.dispatchEvent(new Event('input'));
    const nums = document.querySelectorAll('input[type="number"]');
    (nums[0] as HTMLInputElement).value = '12';
    nums[0]!.dispatchEvent(new Event('input'));
    (nums[1] as HTMLInputElement).value = '3';
    nums[1]!.dispatchEvent(new Event('input'));
    btnExact('Save')!.click();
    await flush();
    await deploy();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/tooling/sobjects/CustomField'),
      expect.objectContaining({
        FullName: 'Contact.Amount__c',
        Metadata: expect.objectContaining({ type: 'Number', precision: 12, scale: 3 }),
      }),
    );
  });

  it('Checkbox: defaultValue from the Default select', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Is Active');
    setRowType('Checkbox');
    await openOptions();
    const selects = document.querySelectorAll('select');
    const defSel = selects[selects.length - 1] as HTMLSelectElement;
    defSel.value = 'checked';
    defSel.dispatchEvent(new Event('change'));
    btnExact('Save')!.click();
    await flush();
    await deploy();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/tooling/sobjects/CustomField'),
      expect.objectContaining({
        Metadata: expect.objectContaining({ type: 'Checkbox', defaultValue: true }),
      }),
    );
  });

  it('Location: displayLocationInDecimal + scale', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Where');
    setRowType('Location');
    await openOptions();
    const decimal = document.querySelector('input[type="number"]') as HTMLInputElement;
    decimal.value = '2';
    decimal.dispatchEvent(new Event('input'));
    const selects = document.querySelectorAll('select');
    const geoSel = selects[selects.length - 1] as HTMLSelectElement;
    geoSel.value = 'degrees';
    geoSel.dispatchEvent(new Event('change'));
    btnExact('Save')!.click();
    await flush();
    await deploy();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/tooling/sobjects/CustomField'),
      expect.objectContaining({
        Metadata: expect.objectContaining({ type: 'Location', displayLocationInDecimal: false, scale: 2 }),
      }),
    );
  });

  it('Picklist: valueSet with sorted + first-value default', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Stage');
    setRowType('Picklist');
    await openOptions();
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'Red\nGreen\n\nBlue';
    area.dispatchEvent(new Event('input'));
    // checkboxes in the picklist option modal: [Sort Alphabetically, First Value as Default]
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    cbs[0]!.checked = true;
    cbs[0]!.dispatchEvent(new Event('change')); // sortalpha
    cbs[1]!.checked = true;
    cbs[1]!.dispatchEvent(new Event('change')); // firstvaluedefault
    btnExact('Save')!.click();
    await flush();
    await deploy();
    const call = (api.apiRequest as any).mock.calls.find((c: any[]) =>
      String(c[1]).includes('/tooling/sobjects/CustomField'),
    );
    const vs = call[2].Metadata.valueSet.valueSetDefinition;
    expect(vs.sorted).toBe(true);
    // empty line filtered out -> three values
    expect(vs.value).toEqual([
      { fullName: 'Red', default: true },
      { fullName: 'Green', default: false },
      { fullName: 'Blue', default: false },
    ]);
  });

  it('MultiselectPicklist: adds visibleLines', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Tags');
    setRowType('MultiselectPicklist');
    await openOptions();
    const area = document.querySelector('textarea') as HTMLTextAreaElement;
    area.value = 'A\nB';
    area.dispatchEvent(new Event('input'));
    const visInput = document.querySelector('input[type="number"]') as HTMLInputElement;
    visInput.value = '5';
    visInput.dispatchEvent(new Event('input'));
    btnExact('Save')!.click();
    await flush();
    await deploy();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/tooling/sobjects/CustomField'),
      expect.objectContaining({
        Metadata: expect.objectContaining({ type: 'MultiselectPicklist', visibleLines: 5 }),
      }),
    );
  });

  it('LongTextArea: length + visibleLines', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Notes');
    setRowType('LongTextArea');
    await openOptions();
    const nums = document.querySelectorAll('input[type="number"]');
    (nums[0] as HTMLInputElement).value = '5000';
    nums[0]!.dispatchEvent(new Event('input'));
    (nums[1] as HTMLInputElement).value = '8';
    nums[1]!.dispatchEvent(new Event('input'));
    btnExact('Save')!.click();
    await flush();
    await deploy();
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/tooling/sobjects/CustomField'),
      expect.objectContaining({
        Metadata: expect.objectContaining({ type: 'LongTextArea', length: 5000, visibleLines: 8 }),
      }),
    );
  });
});

describe('field-creator — FLS permissions', () => {
  it('grants permissions to all fields, toggles individual rows, preloads existing profiles, and posts FieldPermissions', async () => {
    const { api, feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Rating');

    // "Permissions for All" opens the FLS modal with targetField === null
    btnIncludes('Permissions for All')!.click();
    await flush();

    // Initial checkboxes: [readAll, editAll, row1.read, row1.edit, row2.read, row2.edit]
    const cbs = Array.from(document.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(cbs.length).toBeGreaterThanOrEqual(6);

    // Toggle one row's Read, then its Read-Write (exercises the per-row handlers)
    cbs[2]!.checked = true;
    cbs[2]!.dispatchEvent(new Event('change'));
    cbs[3]!.checked = true;
    cbs[3]!.dispatchEvent(new Event('change'));

    // Select-all Read, then select-all Read-Write (re-renders the body each time)
    const readAll = cbs[0]!;
    const editAll = cbs[1]!;
    readAll.checked = true;
    readAll.dispatchEvent(new Event('change'));
    editAll.checked = true;
    editAll.dispatchEvent(new Event('change'));

    btnExact('Save Permissions')!.click();
    await flush();

    // Re-open single-field FLS to hit the profile pre-load branch
    btnIncludes('FLS')!.click();
    await flush();
    btnExact('Cancel')!.click();
    await flush();

    await deploy();

    // CustomField + FieldPermissions both posted; edit access => PermissionsEdit true
    expect(api.apiRequest).toHaveBeenCalledWith(
      'POST',
      expect.stringContaining('/sobjects/FieldPermissions/'),
      expect.objectContaining({
        SobjectType: 'Contact',
        Field: 'Contact.Rating__c',
        PermissionsEdit: true,
        PermissionsRead: true,
      }),
    );
  });
});

describe('field-creator — error & resilience branches', () => {
  it('keeps the modal open when the PermissionSet query fails', async () => {
    const { feature } = mountFC({
      query: vi.fn(async () => {
        throw new Error('no perms');
      }) as any,
    });
    await feature.onActivate?.();
    await flush();
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
  });

  it('toasts when the SObject list fails to load', async () => {
    const { feature } = mountFC({
      apiGet: vi.fn(async () => {
        throw new Error('describe boom');
      }) as any,
    });
    await feature.onActivate?.();
    await flush();
    expect(document.body.textContent).toContain('Failed to load SObject list');
  });

  it('closes when the overlay backdrop is clicked', async () => {
    const { feature } = mountFC();
    await feature.onActivate?.();
    await flush();
    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLDivElement;
    overlay.dispatchEvent(new Event('click'));
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });

  it('marks a field as error when the Tooling API rejects the deploy', async () => {
    const { feature } = mountFC({
      apiRequest: vi.fn(async () => {
        throw new Error('FIELD_INTEGRITY_EXCEPTION');
      }) as any,
    });
    await feature.onActivate?.();
    await flush();
    await selectContactAndLabel('Bad Field');
    await deploy();
    expect(document.body.textContent).toContain('Error');
  });
});
