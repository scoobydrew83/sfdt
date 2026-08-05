// C-P4-5 — the NL→SOQL model, in isolation.
//
// The two properties worth testing here are both NEGATIVE, so they are written
// as refusals rather than as happy paths:
//
//   AC-2  the generator cannot run a query. Asserted structurally — by proxying
//         the dependency object and pinning the exact set of property names
//         `generateSoql()` ever reads. A future `deps.run` shows up here as a
//         failing test before it shows up in an org.
//   AC-4  record data cannot reach the prompt. Asserted twice: the assembler
//         rebuilds every field from an allowlist (so a polluted describe
//         contributes nothing), and the leak gate refuses the send outright if
//         a result-set value ever does appear in the assembled text.
//
// The call-site half — the runner's button, the settings gate, the editor
// hand-off — is test/soql-runner-nl-generate.test.ts.

import { describe, it, expect, vi } from 'vitest';
import {
  MAX_FIELDS_PER_OBJECT,
  PROMPT_FIELD_PROPERTIES,
  SOQL_NL_GENERATE_ID,
  buildGeneratePrompt,
  createSoqlNlGenerateFeature,
  extractSoql,
  generateSoql,
  inferObjectNames,
  normaliseObjectNames,
  parseObjectList,
  recordValueLeak,
  schemaFieldsForPrompt,
  schemaForPrompt,
  schemaMarkdown,
  validateGeneratedSoql,
  type GenerateDeps,
  type PromptSchema,
} from '../features/soql-nl-generate.js';

// A describe as the org actually sends it — every field carries far more than
// the five properties a prompt is allowed to see.
const ACCOUNT_DESCRIBE = {
  name: 'Account',
  label: 'Account',
  keyPrefix: '001',
  fields: [
    {
      name: 'Id',
      label: 'Account ID',
      type: 'id',
      nillable: false,
      inlineHelpText: null,
      updateable: false,
      calculated: false,
    },
    {
      name: 'Name',
      label: 'Account Name',
      type: 'string',
      nillable: false,
      inlineHelpText: 'The legal name',
      length: 255,
    },
    {
      name: 'AnnualRevenue',
      label: 'Annual Revenue',
      type: 'currency',
      nillable: true,
      inlineHelpText: null,
      precision: 18,
    },
  ],
};

const ACCOUNT_SCHEMA = schemaForPrompt('Account', ACCOUNT_DESCRIBE)!;

function deps(overrides: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    describeObject: vi.fn(async () => ACCOUNT_DESCRIBE),
    knownObjects: vi.fn(() => ['Account', 'Contact', 'Opportunity']),
    askAi: vi.fn(async () => ({
      ok: true as const,
      response: '```soql\nSELECT Id, Name FROM Account LIMIT 10\n```',
      provider: 'claude',
    })),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

describe('the schema allowlist (AC-4)', () => {
  it('rebuilds each field from exactly the five allowlisted properties', () => {
    const fields = schemaFieldsForPrompt(ACCOUNT_DESCRIBE);
    expect(fields).toHaveLength(3);
    for (const field of fields) {
      expect(Object.keys(field).sort()).toEqual([...PROMPT_FIELD_PROPERTIES].sort());
    }
  });

  it('drops every property that is not on the list, including record-shaped ones', () => {
    // A describe that has been polluted with rows — the exact accident AC-4 is
    // about. Nothing but the allowlisted five may survive.
    const polluted = {
      name: 'Account',
      label: 'Account',
      records: [{ Id: '001000000000001AAA', Name: 'Universal Containers Holdings' }],
      fields: [
        {
          name: 'Name',
          label: 'Account Name',
          type: 'string',
          nillable: false,
          inlineHelpText: null,
          sampleValue: 'Universal Containers Holdings',
          lastRecordId: '001000000000001AAA',
        },
      ],
    };
    const schema = schemaForPrompt('Account', polluted)!;
    const { prompt } = buildGeneratePrompt({ request: 'all accounts', schemas: [schema] });
    expect(prompt).toContain('| `Name` |');
    expect(prompt).not.toContain('Universal Containers Holdings');
    expect(prompt).not.toContain('001000000000001AAA');
    expect(prompt).not.toContain('sampleValue');
  });

  it('drops field entries that are not objects or have no name', () => {
    expect(
      schemaFieldsForPrompt({ fields: [null, 'Name', 42, { label: 'no name' }, { name: '  ' }] }),
    ).toEqual([]);
  });

  it('returns null for a describe with no usable fields, so no empty schema is sent', () => {
    expect(schemaForPrompt('Account', { name: 'Account', fields: [] })).toBeNull();
    expect(schemaForPrompt('Account', null)).toBeNull();
  });

  it('caps the field list and says so, rather than truncating silently', () => {
    const many = {
      name: 'Account',
      fields: Array.from({ length: MAX_FIELDS_PER_OBJECT + 20 }, (_, i) => ({
        name: `Field_${i}__c`,
        label: `Field ${i}`,
        type: 'string',
        nillable: true,
      })),
    };
    const schema = schemaForPrompt('Account', many)!;
    expect(schema.fields).toHaveLength(MAX_FIELDS_PER_OBJECT);
    expect(schema.totalFields).toBe(MAX_FIELDS_PER_OBJECT + 20);
    const markdown = schemaMarkdown(schema);
    expect(markdown).toContain(`first ${MAX_FIELDS_PER_OBJECT} of ${MAX_FIELDS_PER_OBJECT + 20}`);
    expect(markdown).not.toContain('Field_170__c');
  });
});

describe('prompt assembly (AC-1, AC-4)', () => {
  it('includes the request and the export-for-prompt schema table for every object', () => {
    const contact = schemaForPrompt('Contact', {
      name: 'Contact',
      fields: [{ name: 'Email', label: 'Email', type: 'email', nillable: true }],
    })!;
    const { prompt, objects, fieldNames } = buildGeneratePrompt({
      request: 'accounts with their contacts’ emails',
      schemas: [ACCOUNT_SCHEMA, contact],
    });
    expect(prompt).toContain('## Request');
    expect(prompt).toContain('accounts with their contacts’ emails');
    expect(prompt).toContain('# Schema: Account');
    expect(prompt).toContain('# Schema: Contact');
    // The export-for-prompt table header, byte for byte — one format, two
    // surfaces.
    expect(prompt).toContain('| Field | Label | Type | Required | Description |');
    expect(prompt).toContain('| `AnnualRevenue` | Annual Revenue | currency | No |  |');
    expect(objects).toEqual(['Account', 'Contact']);
    expect(fieldNames).toContain('AnnualRevenue');
    expect(fieldNames).toContain('Email');
  });

  it('tells the model it is SELECT-only and has been given no record data', () => {
    const { prompt } = buildGeneratePrompt({ request: 'x', schemas: [ACCOUNT_SCHEMA] });
    expect(prompt).toContain('Do not emit DML, Apex, or SOSL. SELECT only.');
    expect(prompt).toContain('You have not been given any record data');
  });
});

describe('object resolution', () => {
  it('infers objects named in the request, in the order they were mentioned', () => {
    expect(
      inferObjectNames('opportunities and their account owner', ['Account', 'Opportunity', 'Lead']),
    ).toEqual(['Opportunity', 'Account']);
  });

  it('handles the plurals Salesforce object names actually take', () => {
    expect(inferObjectNames('show me cases', ['Case'])).toEqual(['Case']);
    expect(inferObjectNames('list the opportunities', ['Opportunity'])).toEqual(['Opportunity']);
    expect(inferObjectNames('all accounts', ['Account'])).toEqual(['Account']);
  });

  it('never invents an object the org did not report', () => {
    expect(inferObjectNames('every Widget we own', ['Account'])).toEqual([]);
    expect(inferObjectNames('every Widget we own', [])).toEqual([]);
  });

  it('parses, dedupes and caps a hand-typed object list', () => {
    expect(parseObjectList('Account, contact  Account')).toEqual(['Account', 'contact']);
    expect(parseObjectList('A, B, C, D')).toHaveLength(3);
    // Anything that is not API-name-shaped is dropped rather than escaped —
    // these names end up in a describe URL path, so the filter is the guard.
    expect(parseObjectList('1Bad, table;, Good__c')).toEqual(['Good__c']);
    expect(parseObjectList("Account'--")).toEqual([]);
    expect(parseObjectList(null)).toEqual([]);
    expect(normaliseObjectNames(['Account'], 0)).toEqual([]);
  });
});

describe('reading the model reply', () => {
  it('prefers a fenced block', () => {
    expect(
      extractSoql('Sure!\n```soql\nSELECT Id FROM Account LIMIT 5\n```\nHope that helps.'),
    ).toBe('SELECT Id FROM Account LIMIT 5');
  });

  it('falls back to the first SELECT when the model ignored the fence rule', () => {
    expect(extractSoql('Here you go:\nSELECT Id FROM Account\n\nThis returns every account.')).toBe(
      'SELECT Id FROM Account',
    );
  });

  it('strips a trailing semicolon, which SOQL does not take', () => {
    expect(extractSoql('```\nSELECT Id FROM Account;\n```')).toBe('SELECT Id FROM Account');
  });

  it('returns nothing at all when the reply has no query in it', () => {
    expect(extractSoql('I cannot help with that.')).toBe('');
    expect(extractSoql(null)).toBe('');
  });
});

describe('the local SOQL checks, mirrored from the CLI', () => {
  it('accepts a well-formed query', () => {
    expect(validateGeneratedSoql('SELECT Id, Name FROM Account LIMIT 10').valid).toBe(true);
  });

  it.each([
    ['FIND {Acme} IN ALL FIELDS', 'does not start with SELECT'],
    ['SELECT Id', 'FROM'],
    ['SELECT * FROM Account', 'SELECT *'],
    ['SELECT Id FROM Account; DELETE Account', 'Semicolons'],
    ["SELECT Id FROM Account WHERE Name = 'x", 'Unbalanced single quotes'],
    ['SELECT Id FROM Account WHERE (Name = 1', 'Unbalanced parentheses'],
  ])('rejects %s', (query, reason) => {
    const result = validateGeneratedSoql(query);
    expect(result.valid).toBe(false);
    expect(result.errors.join(' ')).toContain(reason);
  });
});

// ---------------------------------------------------------------------------

describe('the leak backstop (AC-4)', () => {
  const ROWS = [
    {
      attributes: { type: 'Account' },
      Id: '001000000000001AAA',
      Name: 'Universal Containers Holdings',
      Owner: { Name: 'Marguerite Delacroix' },
    },
  ];

  it('finds a record value that reached the prompt, including a nested one', () => {
    expect(recordValueLeak('… Universal Containers Holdings …', 'find accounts', ROWS)).toBe(
      'Universal Containers Holdings',
    );
    expect(recordValueLeak('… 001000000000001AAA …', 'find accounts', ROWS)).toBe(
      '001000000000001AAA',
    );
    expect(recordValueLeak('… Marguerite Delacroix …', 'find accounts', ROWS)).toBe(
      'Marguerite Delacroix',
    );
  });

  it('passes a real assembled prompt built from the same rows’ object', () => {
    const { prompt } = buildGeneratePrompt({
      request: 'accounts by revenue',
      schemas: [ACCOUNT_SCHEMA],
    });
    expect(recordValueLeak(prompt, 'accounts by revenue', ROWS)).toBeNull();
  });

  it('does not flag the user’s own words back at them', () => {
    const request = 'accounts named Universal Containers Holdings';
    const prompt = `## Request\n${request}\n## Schema\n# Schema: Account`;
    expect(recordValueLeak(prompt, request, ROWS)).toBeNull();
  });

  it('ignores the object and field API names the schema legitimately carries', () => {
    const rows = [{ attributes: { type: 'Account' }, Industry: 'AnnualRevenue' }];
    const { prompt, objects, fieldNames } = buildGeneratePrompt({
      request: 'x',
      schemas: [ACCOUNT_SCHEMA],
    });
    expect(recordValueLeak(prompt, 'x', rows)).toBe('AnnualRevenue');
    expect(recordValueLeak(prompt, 'x', rows, { ignore: [...objects, ...fieldNames] })).toBeNull();
  });

  it('is a no-op with no rows on screen', () => {
    expect(recordValueLeak('anything', 'x', [])).toBeNull();
    expect(recordValueLeak('anything', 'x', null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('generateSoql cannot run a query (AC-2)', () => {
  it('reads only the four declared dependencies — none of which can reach the org', async () => {
    const reads = new Set<string>();
    const target = deps({ inspectPrompt: () => null });
    const proxied = new Proxy(target as unknown as Record<string, unknown>, {
      get(t, prop) {
        if (typeof prop === 'string') reads.add(prop);
        return t[prop as string];
      },
    }) as unknown as GenerateDeps;

    const outcome = await generateSoql({ request: 'all accounts' }, proxied);
    expect(outcome.status).toBe('generated');
    // The whole AC-2 argument in one assertion: this function's entire reach
    // into the outside world is these four names. Add an executor and this
    // fails; the extra name is the regression.
    expect([...reads].sort()).toEqual([
      'askAi',
      'describeObject',
      'inspectPrompt',
      'knownObjects',
    ]);
  });

  it('returns the query as a string and nothing that could execute it', async () => {
    const outcome = await generateSoql({ request: 'all accounts' }, deps());
    expect(outcome).toEqual({
      status: 'generated',
      soql: 'SELECT Id, Name FROM Account LIMIT 10',
      objects: ['Account'],
      provider: 'claude',
    });
  });
});

describe('generateSoql gates, in order', () => {
  it('refuses an empty request before touching anything', async () => {
    const d = deps();
    expect(await generateSoql({ request: '   ' }, d)).toEqual({ status: 'no-request' });
    expect(d.knownObjects).not.toHaveBeenCalled();
    expect(d.askAi).not.toHaveBeenCalled();
  });

  it('stops when it cannot work out which object is meant', async () => {
    const d = deps({ knownObjects: () => ['Account'] });
    expect(await generateSoql({ request: 'every widget' }, d)).toEqual({ status: 'no-objects' });
    expect(d.askAi).not.toHaveBeenCalled();
  });

  it('prefers the user’s picked objects over inference, and skips the global describe', async () => {
    const d = deps();
    await generateSoql({ request: 'all accounts', objects: ['Opportunity'] }, d);
    expect(d.knownObjects).not.toHaveBeenCalled();
    expect(d.describeObject).toHaveBeenCalledWith('Opportunity');
  });

  it('stops when nothing could be described', async () => {
    const d = deps({ describeObject: vi.fn(async () => null) });
    expect(await generateSoql({ request: 'all accounts' }, d)).toEqual({
      status: 'no-schema',
      objects: ['Account'],
    });
    expect(d.askAi).not.toHaveBeenCalled();
  });

  it('sends NOTHING when the prompt gate objects (AC-4)', async () => {
    const d = deps({ inspectPrompt: () => 'a row value got into the prompt' });
    expect(await generateSoql({ request: 'all accounts' }, d)).toEqual({
      status: 'blocked',
      message: 'a row value got into the prompt',
    });
    expect(d.askAi).not.toHaveBeenCalled();
  });

  it('treats a gate that threw as a refusal, never as consent', async () => {
    const d = deps({
      inspectPrompt: () => {
        throw new Error('gate exploded');
      },
    });
    const outcome = await generateSoql({ request: 'all accounts' }, d);
    expect(outcome.status).toBe('blocked');
    expect(d.askAi).not.toHaveBeenCalled();
  });

  it('passes the assembled prompt — not the raw request — to the bridge', async () => {
    const sent: string[] = [];
    const askAi = vi.fn(async (prompt: string) => {
      sent.push(prompt);
      return { ok: true as const, response: 'SELECT Id FROM Account' };
    });
    await generateSoql({ request: 'all accounts' }, deps({ askAi }));
    const prompt = sent[0]!;
    expect(prompt).toContain('# Schema: Account');
    expect(prompt).toContain('all accounts');
  });
});

describe('generateSoql failure reporting (AC-3)', () => {
  it('marks a bridge/AI setup failure as unavailable and keeps the throwable', async () => {
    const boom = new Error('Bridge token not configured.');
    const d = deps({
      askAi: async () => ({ ok: false, message: boom.message, unavailable: true, error: boom }),
    });
    expect(await generateSoql({ request: 'all accounts' }, d)).toEqual({
      status: 'unavailable',
      message: 'Bridge token not configured.',
      error: boom,
    });
  });

  it('keeps an ordinary provider failure distinct from an unconfigured one', async () => {
    const d = deps({ askAi: async () => ({ ok: false, message: 'rate limited' }) });
    const outcome = await generateSoql({ request: 'all accounts' }, d);
    expect(outcome.status).toBe('failed');
  });

  it('reports a reply with no query in it rather than pasting prose', async () => {
    const d = deps({ askAi: async () => ({ ok: true, response: 'I would rather not.' }) });
    expect(await generateSoql({ request: 'all accounts' }, d)).toEqual({
      status: 'not-soql',
      response: 'I would rather not.',
    });
  });

  it('reports a query that fails the local checks instead of returning it', async () => {
    const d = deps({
      askAi: async () => ({ ok: true, response: '```soql\nSELECT * FROM Account\n```' }),
    });
    const outcome = await generateSoql({ request: 'all accounts' }, d);
    expect(outcome.status).toBe('invalid');
    if (outcome.status === 'invalid') {
      expect(outcome.errors.join(' ')).toContain('SELECT *');
    }
  });
});

describe('the registry entry', () => {
  it('ships off, with the runner’s contexts and no activation of its own', () => {
    const { manifest, onActivate } = createSoqlNlGenerateFeature();
    expect(manifest.id).toBe(SOQL_NL_GENERATE_ID);
    expect(manifest.enabledByDefault).toBe(false);
    expect(manifest.contexts).toContain('setup_other');
    expect(onActivate).toBeUndefined();
  });
});

// A tiny sanity check that the fixture the whole file leans on is real.
describe('fixtures', () => {
  it('builds a three-field Account schema', () => {
    const schema: PromptSchema = ACCOUNT_SCHEMA;
    expect(schema.objectName).toBe('Account');
    expect(schema.fields.map((f) => f.name)).toEqual(['Id', 'Name', 'AnnualRevenue']);
  });
});
