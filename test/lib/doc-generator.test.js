import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks are only exercised by the generateDocs orchestration tests at the
// bottom of this file; the pure parse/render helpers never touch fs or glob.
vi.mock('glob', () => ({ glob: vi.fn() }));
vi.mock('fs-extra', () => ({
  default: {
    readFile: vi.fn(),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../src/lib/ai.js', () => ({
  runAiPrompt: vi.fn(),
  isAiAvailable: vi.fn().mockResolvedValue(false),
  aiUnavailableMessage: vi.fn().mockReturnValue('AI is not available'),
}));
vi.mock('../../src/lib/prompts.js', () => ({
  getPrompt: vi.fn().mockResolvedValue('TEMPLATE'),
  interpolate: vi.fn((t) => t),
}));

import { glob } from 'glob';
import fs from 'fs-extra';
import { runAiPrompt, isAiAvailable } from '../../src/lib/ai.js';
import {
  generateDocs,
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

describe('generateDocs diagrams and AI gating', () => {
  const FIELD_XML =
    '<fullName>Account__c</fullName><label>Account</label><type>Lookup</type><referenceTo>Account</referenceTo>';

  beforeEach(() => {
    vi.clearAllMocks();
    glob.mockImplementation((pattern) =>
      Promise.resolve(
        pattern === 'objects/*/fields/*.field-meta.xml'
          ? ['/p/force-app/main/default/objects/Invoice__c/fields/Account__c.field-meta.xml']
          : [],
      ),
    );
    fs.readFile.mockResolvedValue(FIELD_XML);
    fs.ensureDir.mockResolvedValue(undefined);
    fs.writeFile.mockResolvedValue(undefined);
    isAiAvailable.mockResolvedValue(false);
  });

  it('writes a standalone ER-diagram page when diagrams is true', async () => {
    const res = await generateDocs({ _projectRoot: '/p' }, { diagrams: true });
    expect(res.diagram).toBe('diagrams/erd.md');
    expect(res.files).toContain('diagrams/erd.md');
    const call = fs.writeFile.mock.calls.find(([p]) => p.endsWith('diagrams/erd.md'));
    expect(call[1]).toContain('erDiagram');
    expect(call[1]).toContain('Invoice__c }o--|| Account : "Account__c"');
  });

  it('skips the standalone diagram page by default', async () => {
    const res = await generateDocs({ _projectRoot: '/p' }, {});
    expect(res.diagram).toBeNull();
    expect(res.files).not.toContain('diagrams/erd.md');
    expect(fs.writeFile.mock.calls.some(([p]) => p.endsWith('diagrams/erd.md'))).toBe(false);
  });

  it('does not attempt the AI overview when the resolved ai option is false', async () => {
    isAiAvailable.mockResolvedValue(true);
    const res = await generateDocs({ _projectRoot: '/p', docs: { ai: true } }, { ai: false });
    expect(res.aiUsed).toBe(false);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });

  it('runs the AI overview when the resolved ai option is true and AI is available', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'Overview prose.' });
    const res = await generateDocs({ _projectRoot: '/p' }, { ai: true });
    expect(res.aiUsed).toBe(true);
    expect(runAiPrompt).toHaveBeenCalled();
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
