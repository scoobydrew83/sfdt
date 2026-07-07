import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDependencyExplorerFeature,
  resolveQueryFor,
  groupByType,
} from '../features/dependency-explorer.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function fakeApi(
  toolingQuery: (soql: string) => Promise<{ records: unknown[]; size: number; done: boolean }>,
): SalesforceApiClient {
  return { toolingQuery } as unknown as SalesforceApiClient;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function runSearch(name: string, type?: string): void {
  const input = document.querySelector('input[type="text"]') as HTMLInputElement;
  input.value = name;
  if (type) {
    const select = document.querySelector('select') as HTMLSelectElement;
    select.value = type;
  }
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === 'Find')!;
  btn.click();
}

describe('resolveQueryFor', () => {
  it('keys Apex* objects on Name', () => {
    expect(resolveQueryFor('ApexClass', 'AccountSvc')).toBe(
      "SELECT Id FROM ApexClass WHERE Name='AccountSvc'",
    );
    expect(resolveQueryFor('ApexTrigger', 'AccTrig')).toBe(
      "SELECT Id FROM ApexTrigger WHERE Name='AccTrig'",
    );
    expect(resolveQueryFor('ApexPage', 'MyPage')).toBe(
      "SELECT Id FROM ApexPage WHERE Name='MyPage'",
    );
  });

  it('resolves Flow against FlowDefinition.DeveloperName', () => {
    expect(resolveQueryFor('Flow', 'My_Flow')).toBe(
      "SELECT Id FROM FlowDefinition WHERE DeveloperName='My_Flow'",
    );
  });

  it('keys LWC and CustomField on DeveloperName', () => {
    expect(resolveQueryFor('LightningComponentBundle', 'myCmp')).toBe(
      "SELECT Id FROM LightningComponentBundle WHERE DeveloperName='myCmp'",
    );
    expect(resolveQueryFor('CustomField', 'Status__c')).toBe(
      "SELECT Id FROM CustomField WHERE DeveloperName='Status__c'",
    );
  });

  it('escapes single quotes to keep the SOQL literal intact', () => {
    expect(resolveQueryFor('ApexClass', "O'Brien")).toBe(
      "SELECT Id FROM ApexClass WHERE Name='O\\'Brien'",
    );
  });

  it('throws on an unsupported type', () => {
    expect(() => resolveQueryFor('Layout', 'x')).toThrow(/Unsupported/);
  });
});

describe('groupByType', () => {
  it('groups by type and sorts types then names', () => {
    const rows = [
      { N: 'Zebra', T: 'ApexClass' },
      { N: 'Alpha', T: 'ApexClass' },
      { N: 'Field__c', T: 'CustomField' },
    ];
    const out = groupByType(rows, 'N', 'T');
    expect(out[0]!.type).toBe('ApexClass');
    expect(out[0]!.names).toEqual(['Alpha', 'Zebra']);
    expect(out[1]!.type).toBe('CustomField');
  });

  it('falls back to (unknown) for missing keys', () => {
    const out = groupByType([{}], 'N', 'T');
    expect(out[0]!.type).toBe('(unknown)');
    expect(out[0]!.names).toEqual(['(unknown)']);
  });
});

describe('dependency-explorer feature', () => {
  beforeEach(clearBody);

  it('resolves an Id then renders both dependency sections with counts', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.startsWith('SELECT Id FROM ApexClass')) {
        return { records: [{ Id: '01p000000000001' }], size: 1, done: true };
      }
      if (soql.includes('WHERE MetadataComponentId')) {
        return {
          records: [
            { RefMetadataComponentName: 'Contact', RefMetadataComponentType: 'CustomObject' },
          ],
          size: 1,
          done: true,
        };
      }
      // referenced-by (WHERE RefMetadataComponentId)
      return {
        records: [
          { MetadataComponentName: 'AccountTrigger', MetadataComponentType: 'ApexTrigger' },
        ],
        size: 1,
        done: true,
      };
    });
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    runSearch('AccountSvc', 'ApexClass');
    await flush();

    expect(toolingQuery).toHaveBeenCalledTimes(3); // resolve + references + referencedBy
    const text = document.body.textContent ?? '';
    expect(text).toContain('References (this → others) (1)');
    expect(text).toContain('Contact');
    expect(text).toContain('Referenced by (others → this) (1)');
    expect(text).toContain('AccountTrigger');
  });

  it('openFor pre-fills the component and runs the search immediately (cross-link)', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.startsWith('SELECT Id FROM ApexClass')) {
        return { records: [{ Id: '01p000000000009' }], size: 1, done: true };
      }
      if (soql.includes('WHERE MetadataComponentId')) {
        return {
          records: [{ RefMetadataComponentName: 'Contact', RefMetadataComponentType: 'CustomObject' }],
          size: 1,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.openFor('ApexClass', 'AccountSvc');
    await flush();

    const input = document.querySelector('input[type="text"]') as HTMLInputElement;
    expect(input.value).toBe('AccountSvc');
    expect(toolingQuery).toHaveBeenCalledWith("SELECT Id FROM ApexClass WHERE Name='AccountSvc'");
    expect(document.body.textContent).toContain('Contact');
  });

  it('shows a clear message when the name is not found', async () => {
    const toolingQuery = vi.fn(async () => ({ records: [], size: 0, done: true }));
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    runSearch('Nope', 'ApexClass');
    await flush();

    expect(toolingQuery).toHaveBeenCalledTimes(1); // only the resolve query runs
    expect(document.body.textContent).toContain('No ApexClass named "Nope" found');
  });

  it('shows a friendly empty state when there are zero dependencies', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.startsWith('SELECT Id')) {
        return { records: [{ Id: '01p000000000001' }], size: 1, done: true };
      }
      return { records: [], size: 0, done: true };
    });
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    runSearch('Lonely', 'ApexClass');
    await flush();

    expect(document.body.textContent).toContain('No metadata dependencies recorded');
  });

  it('notes ambiguity when a CustomField name matches multiple fields', async () => {
    const toolingQuery = vi.fn(async (soql: string) => {
      if (soql.startsWith('SELECT Id')) {
        return {
          records: [{ Id: '00N000000000001' }, { Id: '00N000000000002' }],
          size: 2,
          done: true,
        };
      }
      return { records: [], size: 0, done: true };
    });
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    runSearch('Status__c', 'CustomField');
    await flush();

    expect(document.body.textContent).toContain('2 fields share this name');
  });

  it('surfaces a query error in an error panel', async () => {
    const toolingQuery = vi.fn(async () => { throw new Error('MALFORMED_QUERY: bad'); });
    const feature = createDependencyExplorerFeature({ api: fakeApi(toolingQuery) });
    await feature.onActivate?.();
    await flush();

    runSearch('AccountSvc', 'ApexClass');
    await flush();

    expect(document.body.textContent).toContain('MALFORMED_QUERY');
  });
});
