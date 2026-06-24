import { describe, it, expect } from 'vitest';
import {
  parseField,
  parseApexMeta,
  extractApexMethods,
  renderObjectMarkdown,
  renderApexMarkdown,
  renderFlowMarkdown,
  buildErdMermaid,
  renderIndex,
  renderMkDocsConfig,
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
});
