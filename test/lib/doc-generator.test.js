import { describe, it, expect } from 'vitest';
import {
  parseField,
  parseApexMeta,
  parseLwcMeta,
  extractApexMethods,
  extractLwcApi,
  extractLwcApexImports,
  renderObjectMarkdown,
  renderApexMarkdown,
  renderFlowMarkdown,
  renderLwcMarkdown,
  buildErdMermaid,
  renderIndex,
  renderMkDocsConfig,
  buildComponentSource,
  resolveRoles,
  ROLE_GUIDES,
} from '../../src/lib/doc-generator.js';

describe('parseField', () => {
  it('parses a field-meta xml body', () => {
    const xml = `<fullName>Account__c</fullName><label>Account</label><type>Lookup</type><required>true</required><referenceTo>Account</referenceTo>`;
    expect(parseField(xml, 'fallback')).toMatchObject({
      name: 'Account__c',
      label: 'Account',
      type: 'Lookup',
      required: true,
      referenceTo: 'Account',
    });
  });

  it('falls back to the filename when fullName is absent', () => {
    expect(parseField('<type>Text</type>', 'MyField__c').name).toBe('MyField__c');
  });

  it('decodes XML entities', () => {
    expect(parseField('<label>A &amp; B</label>', 'x').label).toBe('A & B');
  });
});

describe('parseApexMeta', () => {
  it('reads the api version', () => {
    expect(parseApexMeta('<apiVersion>59.0</apiVersion>').apiVersion).toBe('59.0');
  });
});

describe('extractApexMethods', () => {
  it('extracts method names and ignores control keywords', () => {
    const body = `public class Foo { public void doThing() {} private Integer calc(Integer x) { if (x>0) {} return x; } }`;
    const methods = extractApexMethods(body);
    expect(methods).toContain('doThing');
    expect(methods).toContain('calc');
    expect(methods).not.toContain('if');
  });
});

describe('renderObjectMarkdown', () => {
  it('renders a field table', () => {
    const md = renderObjectMarkdown({
      name: 'Invoice__c',
      label: 'Invoice',
      fields: [{ name: 'Amount__c', label: 'Amount', type: 'Currency', required: true, referenceTo: null }],
    });
    expect(md).toContain('# Invoice');
    expect(md).toContain('`Invoice__c`');
    expect(md).toContain('| `Amount__c` | Amount | Currency | ✓ |');
  });

  it('notes when there are no custom fields', () => {
    expect(renderObjectMarkdown({ name: 'X', fields: [] })).toContain('No custom fields');
  });
});

describe('renderApexMarkdown', () => {
  it('marks test classes and lists methods', () => {
    const md = renderApexMarkdown({ name: 'FooTest', isTest: true, apiVersion: '59.0', methods: ['testIt'], doc: 'Docs' });
    expect(md).toContain('# FooTest _(test)_');
    expect(md).toContain('`testIt()`');
    expect(md).toContain('**API version:** 59.0');
  });
});

describe('renderFlowMarkdown', () => {
  it('renders flow metadata', () => {
    const md = renderFlowMarkdown({ name: 'My_Flow', label: 'My Flow', status: 'Active', processType: 'Flow' });
    expect(md).toContain('# My Flow');
    expect(md).toContain('Status:** Active');
  });
});

describe('buildErdMermaid', () => {
  it('emits relationships and entity blocks', () => {
    const objects = [
      { name: 'Invoice__c', fields: [{ name: 'Account__c', type: 'Lookup', referenceTo: 'Account' }] },
    ];
    const mermaid = buildErdMermaid(objects);
    expect(mermaid).toContain('erDiagram');
    expect(mermaid).toContain('Invoice__c }o--|| Account : "Account__c"');
    expect(mermaid.startsWith('```mermaid')).toBe(true);
  });
});

describe('renderIndex', () => {
  it('includes counts, overview, and the ER diagram', () => {
    const meta = { objects: [{ name: 'A', fields: [] }], apex: [{ name: 'C' }], flows: [] };
    const md = renderIndex(meta, 'AI overview text');
    expect(md).toContain('AI overview text');
    expect(md).toContain('**1** objects');
    expect(md).toContain('erDiagram');
  });
});

describe('renderMkDocsConfig', () => {
  it('builds a nav from collected metadata', () => {
    const yml = renderMkDocsConfig({ projectName: 'Acme' }, { objects: [{ name: 'A' }], apex: [], flows: [] });
    expect(yml).toContain('site_name: Acme Documentation');
    expect(yml).toContain('- A: objects/A.md');
  });

  it('adds Lightning components to the nav when present', () => {
    const yml = renderMkDocsConfig({ projectName: 'Acme' }, { objects: [], apex: [], flows: [], lwc: [{ name: 'myCmp' }] });
    expect(yml).toContain('- Lightning Components:');
    expect(yml).toContain('- myCmp: lwc/myCmp.md');
  });
});

describe('parseLwcMeta', () => {
  it('parses label, exposure, and targets', () => {
    const xml = `<masterLabel>My Component</masterLabel><isExposed>true</isExposed><apiVersion>59.0</apiVersion><targets><target>lightning__AppPage</target><target>lightning__RecordPage</target></targets>`;
    expect(parseLwcMeta(xml)).toMatchObject({
      masterLabel: 'My Component',
      isExposed: true,
      apiVersion: '59.0',
      targets: ['lightning__AppPage', 'lightning__RecordPage'],
    });
  });

  it('treats a missing isExposed as not exposed', () => {
    expect(parseLwcMeta('<masterLabel>X</masterLabel>').isExposed).toBe(false);
  });
});

describe('extractLwcApi', () => {
  it('collects @api property and getter names, deduped', () => {
    const js = `export default class C extends LightningElement {\n  @api recordId;\n  @api get value() {}\n  @api set value(v) {}\n}`;
    const props = extractLwcApi(js);
    expect(props).toContain('recordId');
    expect(props).toContain('value');
    expect(props.filter((p) => p === 'value')).toHaveLength(1);
  });
});

describe('extractLwcApexImports', () => {
  it('extracts Apex Class.method references', () => {
    const js = `import getList from '@salesforce/apex/MyController.getList';`;
    expect(extractLwcApexImports(js)).toEqual(['MyController.getList']);
  });
});

describe('renderLwcMarkdown', () => {
  it('renders exposure, api props, and apex usage', () => {
    const md = renderLwcMarkdown({
      name: 'myCmp',
      label: 'My Cmp',
      apiVersion: '59.0',
      isExposed: true,
      targets: ['lightning__AppPage'],
      apiProps: ['recordId'],
      apexImports: ['MyController.getList'],
    });
    expect(md).toContain('# My Cmp');
    expect(md).toContain('**Exposed:** yes');
    expect(md).toContain('`recordId`');
    expect(md).toContain('`MyController.getList`');
  });
});

describe('resolveRoles', () => {
  it('keeps only known roles, lowercased and deduped', () => {
    expect(resolveRoles(['Developer', 'admin', 'admin', 'bogus'])).toEqual(['developer', 'admin']);
  });
  it('exposes all four built-in roles', () => {
    expect(Object.keys(ROLE_GUIDES)).toEqual(['developer', 'admin', 'user', 'devops']);
  });
});

describe('buildComponentSource', () => {
  it('serializes an LWC with a pointer to the bundle files', () => {
    const src = buildComponentSource('lwc', { name: 'myCmp', label: 'My Cmp', apiProps: ['recordId'], apexImports: ['C.m'], targets: [] }, 'force-app/main/default');
    expect(src).toContain('LWC bundle: myCmp');
    expect(src).toContain('@api properties: recordId');
    expect(src).toContain('force-app/main/default/lwc/myCmp/');
  });

  it('serializes an Apex class with its method list and file pointer', () => {
    const src = buildComponentSource('apex', { name: 'Ctrl', methods: ['getList'], isTest: false }, 'src');
    expect(src).toContain('Apex class: Ctrl');
    expect(src).toContain('getList()');
    expect(src).toContain('src/classes/Ctrl.cls');
  });
});
