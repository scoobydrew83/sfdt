import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  isAiAvailable: vi.fn(),
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
  collectProjectMetadata,
  generateDocs,
  buildComponentSource,
} from '../../src/lib/doc-generator.js';

const BASE = '/project/force-app/main/default';

// Virtual filesystem: pattern -> absolute paths, and path -> content.
const GLOBS = {
  'objects/*/fields/*.field-meta.xml': [
    `${BASE}/objects/Invoice__c/fields/Amount__c.field-meta.xml`,
    `${BASE}/objects/Invoice__c/fields/Account__c.field-meta.xml`,
  ],
  'objects/*/*.object-meta.xml': [
    `${BASE}/objects/Invoice__c/Invoice__c.object-meta.xml`,
    `${BASE}/objects/Empty__c/Empty__c.object-meta.xml`,
  ],
  'classes/*.cls': [`${BASE}/classes/FooController.cls`, `${BASE}/classes/FooTest.cls`],
  'flows/*.flow-meta.xml': [`${BASE}/flows/My_Flow.flow-meta.xml`],
  'lwc/*/*.js-meta.xml': [`${BASE}/lwc/myCmp/myCmp.js-meta.xml`],
};

const FILES = {
  [`${BASE}/objects/Invoice__c/fields/Amount__c.field-meta.xml`]:
    '<fullName>Amount__c</fullName><label>Amount</label><type>Currency</type><required>true</required>',
  [`${BASE}/objects/Invoice__c/fields/Account__c.field-meta.xml`]:
    '<fullName>Account__c</fullName><label>Account</label><type>Lookup</type><referenceTo>Account</referenceTo>',
  [`${BASE}/objects/Invoice__c/Invoice__c.object-meta.xml`]:
    '<label>Invoice</label><description>An invoice</description>',
  [`${BASE}/objects/Empty__c/Empty__c.object-meta.xml`]: '<label>Empty</label>',
  [`${BASE}/classes/FooController.cls`]:
    '/**\n * Controls foo.\n */\npublic with sharing class FooController {\n  public Integer getList() { return 1; }\n}',
  [`${BASE}/classes/FooController.cls-meta.xml`]: '<apiVersion>59.0</apiVersion>',
  [`${BASE}/classes/FooTest.cls`]: '@isTest\nprivate class FooTest { static void t() {} }',
  [`${BASE}/classes/FooTest.cls-meta.xml`]: '',
  [`${BASE}/flows/My_Flow.flow-meta.xml`]:
    '<label>My Flow</label><status>Active</status><processType>Flow</processType>',
  [`${BASE}/lwc/myCmp/myCmp.js-meta.xml`]:
    '<masterLabel>My Cmp</masterLabel><isExposed>true</isExposed><apiVersion>59.0</apiVersion><targets><target>lightning__AppPage</target></targets>',
  [`${BASE}/lwc/myCmp/myCmp.js`]:
    "import getList from '@salesforce/apex/FooController.getList';\nexport default class C { @api recordId; }",
};

beforeEach(() => {
  vi.clearAllMocks();
  glob.mockImplementation((pattern) => Promise.resolve(GLOBS[pattern] ?? []));
  fs.readFile.mockImplementation((p) => Promise.resolve(FILES[p] ?? ''));
  fs.ensureDir.mockResolvedValue(undefined);
  fs.writeFile.mockResolvedValue(undefined);
  isAiAvailable.mockResolvedValue(false);
});

const config = { _projectRoot: '/project', _configDir: '/project/.sfdt', projectName: 'Acme' };

describe('collectProjectMetadata', () => {
  it('collects and sorts objects, apex, flows, and lwc from source', async () => {
    const meta = await collectProjectMetadata(config);

    expect(meta.sourcePath).toBe('force-app/main/default');

    // Objects: Empty__c (no fields) sorts before Invoice__c.
    expect(meta.objects.map((o) => o.name)).toEqual(['Empty__c', 'Invoice__c']);
    const invoice = meta.objects.find((o) => o.name === 'Invoice__c');
    expect(invoice.label).toBe('Invoice');
    expect(invoice.description).toBe('An invoice');
    expect(invoice.fields).toHaveLength(2);
    const empty = meta.objects.find((o) => o.name === 'Empty__c');
    expect(empty.fields).toHaveLength(0);
    expect(empty.label).toBe('Empty');

    // Apex: parses meta version, leading doc comment, isTest flag, methods.
    expect(meta.apex.map((c) => c.name)).toEqual(['FooController', 'FooTest']);
    const foo = meta.apex[0];
    expect(foo.apiVersion).toBe('59.0');
    expect(foo.isTest).toBe(false);
    expect(foo.doc).toBe('Controls foo.');
    expect(foo.methods).toContain('getList');
    expect(meta.apex[1].isTest).toBe(true);

    // Flows.
    expect(meta.flows).toHaveLength(1);
    expect(meta.flows[0]).toMatchObject({ name: 'My_Flow', label: 'My Flow', status: 'Active' });

    // LWC: meta + js parsed.
    expect(meta.lwc).toHaveLength(1);
    expect(meta.lwc[0]).toMatchObject({ name: 'myCmp', label: 'My Cmp', isExposed: true });
    expect(meta.lwc[0].apexImports).toEqual(['FooController.getList']);
    expect(meta.lwc[0].apiProps).toEqual(['recordId']);
  });

  it('tolerates unreadable files by treating them as empty', async () => {
    fs.readFile.mockRejectedValue(new Error('EACCES'));
    const meta = await collectProjectMetadata(config);
    // Fields still register (keyed off filename); parse just yields fallbacks.
    const invoice = meta.objects.find((o) => o.name === 'Invoice__c');
    expect(invoice.fields.map((f) => f.name).sort()).toEqual(['Account__c', 'Amount__c']);
    expect(invoice.fields[0].type).toBe('Unknown');
  });

  it('defaults source path and root when config omits them', async () => {
    glob.mockResolvedValue([]);
    const meta = await collectProjectMetadata({});
    expect(meta.sourcePath).toBe('force-app/main/default');
    expect(meta).toMatchObject({ objects: [], apex: [], flows: [], lwc: [] });
  });
});

describe('generateDocs', () => {
  it('writes index, per-component, and mkdocs files without AI', async () => {
    const res = await generateDocs(config, { ai: false });

    expect(res.aiUsed).toBe(false);
    expect(res.guides).toBeNull();
    expect(res.counts).toEqual({ objects: 2, apex: 2, flows: 1, lwc: 1 });
    expect(res.outputDir).toBe('/project/docs');

    expect(res.files).toContain('index.md');
    expect(res.files).toContain('mkdocs.yml');
    expect(res.files).toEqual(expect.arrayContaining([expect.stringMatching(/objects[\\/]Invoice__c\.md$/)]));
    expect(res.files).toEqual(expect.arrayContaining([expect.stringMatching(/apex[\\/]FooController\.md$/)]));
    expect(res.files).toEqual(expect.arrayContaining([expect.stringMatching(/lwc[\\/]myCmp\.md$/)]));

    // Every write ensures its dir and appends a trailing newline.
    const indexCall = fs.writeFile.mock.calls.find(([p]) => p.endsWith('index.md'));
    expect(indexCall[1].endsWith('\n')).toBe(true);
  });

  it('resolves an absolute docs.outputDir as-is', async () => {
    const res = await generateDocs({ ...config, docs: { outputDir: '/abs/out' } }, {});
    expect(res.outputDir).toBe('/abs/out');
  });

  it('enriches the index with an AI overview when AI is available', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'Project overview prose.\n' });

    const res = await generateDocs(config, { ai: true });
    expect(res.aiUsed).toBe(true);
    const indexCall = fs.writeFile.mock.calls.find(([p]) => p.endsWith('index.md'));
    expect(indexCall[1]).toContain('Project overview prose.');
  });

  it('does not mark AI used when the overview comes back empty', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: '   ' });
    const res = await generateDocs(config, { ai: true });
    expect(res.aiUsed).toBe(false);
  });

  it('swallows AI overview errors and continues', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockRejectedValue(new Error('boom'));
    const res = await generateDocs(config, { ai: true });
    expect(res.aiUsed).toBe(false);
    expect(res.files).toContain('index.md');
  });

  it('respects config.docs.ai=false even when ai option is set', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: 'unused' });
    const res = await generateDocs({ ...config, docs: { ai: false } }, { ai: true });
    expect(res.aiUsed).toBe(false);
    expect(runAiPrompt).not.toHaveBeenCalled();
  });
});

describe('generateDocs role guides', () => {
  it('throws when roles are requested but AI is unavailable', async () => {
    isAiAvailable.mockResolvedValue(false);
    await expect(
      generateDocs({ ...config, features: { ai: true } }, { roles: ['developer'] }),
    ).rejects.toThrow('AI is not available');
  });

  it('generates per-component role guides and reports progress', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: '# Guide body' });
    const progress = [];

    const res = await generateDocs(
      { ...config, features: { ai: true } },
      { roles: ['Developer', 'bogus'], onProgress: (m) => progress.push(m) },
    );

    expect(res.guides.roles).toEqual(['developer']);
    // 4 components (2 objects + 2 apex + 1 flow + 1 lwc) -> actually 6 components x 1 role.
    expect(res.guides.written).toBe(6);
    expect(res.guides.skipped).toHaveLength(0);
    expect(res.guides.files.some((f) => /guides[\\/]apex[\\/]FooController[\\/]developer\.md$/.test(f))).toBe(true);
    expect(progress.some((m) => /Generating 6 role guides/.test(m))).toBe(true);
    expect(progress.some((m) => /Guides \d+\/6/.test(m))).toBe(true);
  });

  it('records components as skipped when the AI returns nothing', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockResolvedValue({ stdout: '' });

    const res = await generateDocs(
      { ...config, features: { ai: true } },
      { roles: ['developer'] },
    );
    expect(res.guides.written).toBe(0);
    expect(res.guides.skipped).toHaveLength(6);
    expect(res.guides.skipped[0]).toHaveProperty('role', 'developer');
  });

  it('treats an AI call that throws as a skipped guide', async () => {
    isAiAvailable.mockResolvedValue(true);
    runAiPrompt.mockRejectedValue(new Error('rate limit'));
    const res = await generateDocs(
      { ...config, features: { ai: true } },
      { roles: ['developer'] },
    );
    expect(res.guides.written).toBe(0);
    expect(res.guides.skipped).toHaveLength(6);
  });
});

describe('buildComponentSource (object/flow branches)', () => {
  it('serializes an object with its field list and references', () => {
    const src = buildComponentSource(
      'object',
      {
        name: 'Invoice__c',
        label: 'Invoice',
        description: 'An invoice',
        fields: [
          { name: 'Amount__c', type: 'Currency', required: true },
          { name: 'Account__c', type: 'Lookup', referenceTo: 'Account' },
        ],
      },
      'src',
    );
    expect(src).toContain('Custom object: Invoice__c (label: Invoice)');
    expect(src).toContain('- Amount__c (Currency) required');
    expect(src).toContain('- Account__c (Lookup) -> Account');
    expect(src).toContain('src/objects/Invoice__c/');
  });

  it('serializes a flow with type, status, and a file pointer', () => {
    const src = buildComponentSource(
      'flow',
      { name: 'My_Flow', label: 'My Flow', processType: 'Flow', status: 'Active' },
      'src',
    );
    expect(src).toContain('Flow: My Flow (API name: My_Flow)');
    expect(src).toContain('Type: Flow');
    expect(src).toContain('Status: Active');
    expect(src).toContain('src/flows/My_Flow.flow-meta.xml');
  });
});
