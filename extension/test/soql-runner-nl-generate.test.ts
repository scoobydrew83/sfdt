// C-P4-5 — NL→SOQL, as WIRED INTO the SOQL runner.
//
// features/soql-nl-generate.ts owns the model and test/soql-nl-generate.test.ts
// pins it in isolation. This file pins the call site, because a guarantee that
// holds in the model and is broken by the UI is not a guarantee:
//
//   - the control is not BUILT unless the user opted in (AC-3);
//   - a generated query lands in the editor and the org is never touched — the
//     Salesforce client records zero query calls across a whole generation, and
//     then one as soon as the user presses Run, so the assertion is not vacuous
//     (AC-2);
//   - what goes on the wire is schema, and never a value from the table that is
//     on screen at that moment (AC-4);
//   - with no bridge, the panel says how to get one (AC-3);
//   - Escape, focus and labelling behave (CONVENTIONS.md).
//
// Separate from test/soql-runner.test.ts, which is already 2,200 lines, so the
// AI path has one file a reviewer can read end to end.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createSoqlRunnerFeature } from '../features/soql-runner.js';
import { SOQL_NL_GENERATE_ID } from '../features/soql-nl-generate.js';
import {
  _resetSettingsShapesForTests,
  _clearSettingsCacheForTests,
  patchSettings,
} from '../lib/settings.js';
import { _resetDescribeCachesForTests } from '../lib/describe-cache.js';
import type { SalesforceApiClient, QueryEnvelope } from '../lib/salesforce-api.js';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const settle = async (times = 6): Promise<void> => {
  for (let i = 0; i < times; i += 1) await tick();
};

const byText = (text: string): HTMLButtonElement | undefined =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === text);
const generateTrigger = (): HTMLButtonElement | undefined => byText('Generate query');
const panel = (): HTMLElement | null =>
  document.querySelector('[aria-label="Generate SOQL from a description"]');
const requestBox = (): HTMLTextAreaElement =>
  panel()!.querySelector('textarea') as HTMLTextAreaElement;
const objectsBox = (): HTMLInputElement => panel()!.querySelector('input') as HTMLInputElement;
const editorBox = (): HTMLTextAreaElement =>
  document.querySelector('textarea.sfdt-editor-input') as HTMLTextAreaElement;
const errorBlock = (): HTMLElement | null =>
  (panel()?.querySelector('.sfdt-console.sfdt-error') as HTMLElement | null) ?? null;

const ACCOUNT_DESCRIBE = {
  name: 'Account',
  label: 'Account',
  fields: [
    { name: 'Id', label: 'Account ID', type: 'id', nillable: false, inlineHelpText: null },
    { name: 'Name', label: 'Account Name', type: 'string', nillable: false, inlineHelpText: null },
  ],
};

const GLOBAL_DESCRIBE = {
  sobjects: [
    { name: 'Account', label: 'Account', keyPrefix: '001' },
    { name: 'Contact', label: 'Contact', keyPrefix: '003' },
  ],
};

/** A row whose values must never turn up in a prompt. */
const SECRET_ROWS = [
  {
    attributes: { type: 'Account' },
    Id: '001000000000001AAA',
    Name: 'Zenith Prosthetics Consortium',
  },
];

function fakeApi(overrides: Partial<SalesforceApiClient> = {}): SalesforceApiClient {
  return {
    apiVersion: 'v62.0',
    orgOrigin: 'https://x.lightning.force.com',
    query: vi.fn(
      async () =>
        ({ totalSize: 0, done: true, records: [] }) as QueryEnvelope<Record<string, unknown>>,
    ),
    toolingQuery: vi.fn(async () => ({ size: 0, done: true, records: [] })),
    queryMore: vi.fn(
      async () =>
        ({ totalSize: 0, done: true, records: [] }) as QueryEnvelope<Record<string, unknown>>,
    ),
    apiGet: vi.fn(async (endpoint: string) => {
      if (endpoint.endsWith('/describe')) return ACCOUNT_DESCRIBE;
      if (endpoint.endsWith('/sobjects/')) return GLOBAL_DESCRIBE;
      return {};
    }),
    apiRequest: vi.fn(async () => null),
    ...overrides,
  } as unknown as SalesforceApiClient;
}

interface OpenOpts {
  enabled?: boolean;
  rows?: Array<Record<string, unknown>>;
  reply?: string;
  bridgeResponse?: SfdtResponse;
  bridgeThrows?: Error;
  api?: Partial<SalesforceApiClient>;
}

interface Harness {
  api: SalesforceApiClient;
  /** Every prompt string handed to the bridge. */
  prompts: string[];
  /** Every request envelope handed to the bridge. */
  calls: Array<Record<string, unknown>>;
}

async function openRunner(opts: OpenOpts = {}): Promise<Harness> {
  if (opts.enabled !== false) {
    await patchSettings({ features: { [SOQL_NL_GENERATE_ID]: true } });
  }
  const api = fakeApi(opts.api);
  const prompts: string[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const bridge = {
    call: vi.fn(async (request: Record<string, unknown>) => {
      calls.push(request);
      if (typeof request.prompt === 'string') prompts.push(request.prompt);
      if (opts.bridgeThrows) throw opts.bridgeThrows;
      return (
        opts.bridgeResponse ?? {
          ok: true,
          requestId: 'r1',
          data: {
            response: opts.reply ?? '```soql\nSELECT Id, Name FROM Account LIMIT 10\n```',
            provider: 'claude',
          },
        }
      );
    }),
  };
  const feature = createSoqlRunnerFeature({
    api,
    bridgeFactory: async () => bridge as never,
  });
  await feature.onActivate?.();
  await settle();

  if (opts.rows) {
    (api.query as ReturnType<typeof vi.fn>).mockResolvedValue({
      totalSize: opts.rows.length,
      done: true,
      records: opts.rows,
    });
    editorBox().value = 'SELECT Id, Name FROM Account';
    byText('Run')!.click();
    await settle();
    (api.query as ReturnType<typeof vi.fn>).mockClear();
  }
  return { api, prompts, calls };
}

/** Open the panel, type a description, press Generate. */
async function generate(description = 'all accounts', objects?: string): Promise<void> {
  generateTrigger()!.click();
  requestBox().value = description;
  if (objects !== undefined) objectsBox().value = objects;
  byText('Generate')!.click();
  await settle(10);
}

beforeEach(() => {
  _resetSettingsShapesForTests();
  _clearSettingsCacheForTests();
  _resetDescribeCachesForTests();
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/Flows/home');
});

// ---------------------------------------------------------------------------

describe('the feature gate (AC-3)', () => {
  it('builds no trigger and no panel at all for a user who has not opted in', async () => {
    await openRunner({ enabled: false });
    expect(generateTrigger()).toBeUndefined();
    expect(panel()).toBeNull();
    // Absent, not hidden — a hidden control is one style write from being live.
    expect(document.body.textContent).not.toContain('Generate');
  });

  it('is off for a user with no stored preference at all', async () => {
    // No patchSettings() call: this is the out-of-the-box state, which is what
    // `enabledByDefault: false` has to actually produce at runtime.
    const api = fakeApi();
    const feature = createSoqlRunnerFeature({ api });
    await feature.onActivate?.();
    await settle();
    expect(generateTrigger()).toBeUndefined();
  });

  it('builds the trigger once the user opts in, collapsed', async () => {
    await openRunner();
    const trigger = generateTrigger()!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-controls')).toBe(panel()!.id);
    expect(panel()!.style.display).toBe('none');
  });
});

describe('a generated query never runs itself (AC-2)', () => {
  it('puts the query in the editor and makes ZERO org calls doing it', async () => {
    const { api } = await openRunner();
    await generate();

    expect(editorBox().value).toBe('SELECT Id, Name FROM Account LIMIT 10');
    // The three ways this feature's file can reach an org. None of them fired.
    expect(api.query).not.toHaveBeenCalled();
    expect(api.toolingQuery).not.toHaveBeenCalled();
    expect(api.apiRequest).not.toHaveBeenCalled();
    // …and the only apiGet traffic is describes, which is the schema fetch.
    for (const call of (api.apiGet as ReturnType<typeof vi.fn>).mock.calls) {
      expect(String(call[0])).toMatch(/\/(describe|sobjects\/)$|\/describe$/);
    }
  });

  it('is not vacuous: the SAME query runs the moment the user presses Run', async () => {
    const { api } = await openRunner();
    await generate();
    expect(api.query).not.toHaveBeenCalled();

    byText('Run')!.click();
    await settle();
    expect(api.query).toHaveBeenCalledTimes(1);
    expect((api.query as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe(
      'SELECT Id, Name FROM Account LIMIT 10',
    );
  });

  it('offers no run affordance inside the panel at all', async () => {
    await openRunner();
    generateTrigger()!.click();
    const labels = Array.from(panel()!.querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Generate', 'Close']);
  });

  it('reports an unusable answer instead of pasting it over the draft', async () => {
    const { api } = await openRunner({ reply: '```soql\nSELECT * FROM Account\n```' });
    generateTrigger()!.click();
    editorBox().value = 'SELECT Id FROM Contact';
    requestBox().value = 'all accounts';
    byText('Generate')!.click();
    await settle(10);

    expect(editorBox().value).toBe('SELECT Id FROM Contact');
    expect(errorBlock()?.textContent).toContain('SELECT *');
    expect(api.query).not.toHaveBeenCalled();
  });
});

describe('what goes on the wire is schema, not data (AC-1, AC-4)', () => {
  it('routes the prompt through the ai-assistant bridge contract, unchanged', async () => {
    const { calls } = await openRunner();
    await generate();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe('ai');
    expect(typeof calls[0]!.prompt).toBe('string');
  });

  it('sends the object’s schema table', async () => {
    const { prompts } = await openRunner();
    await generate('all accounts');
    expect(prompts[0]).toContain('# Schema: Account');
    expect(prompts[0]).toContain('| Field | Label | Type | Required | Description |');
    expect(prompts[0]).toContain('| `Name` | Account Name | string | Yes |');
  });

  it('carries NO value from the result set that is on screen', async () => {
    const { prompts } = await openRunner({ rows: SECRET_ROWS });
    // The table is up, with a distinctive name and a record Id in it.
    expect(document.body.textContent).toContain('Zenith Prosthetics Consortium');

    await generate('all accounts');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain('Zenith Prosthetics Consortium');
    expect(prompts[0]).not.toContain('001000000000001AAA');
    // …while still being a real prompt, so the assertion above means something.
    expect(prompts[0]).toContain('# Schema: Account');
  });

  it('honours a hand-typed object list rather than inferring', async () => {
    const { prompts, api } = await openRunner();
    await generate('everything about them', 'Contact');
    expect(prompts[0]).toContain('# Schema:');
    const described = (api.apiGet as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(described.some((e) => e.includes('/sobjects/Contact/describe'))).toBe(true);
  });

  it('asks for an object when it cannot work one out, and sends nothing', async () => {
    const { calls } = await openRunner();
    await generate('show me every widget we own');
    expect(calls).toHaveLength(0);
    expect(errorBlock()?.textContent).toContain('Objects box');
  });

  it('refuses an empty description without calling the bridge', async () => {
    const { calls } = await openRunner();
    generateTrigger()!.click();
    byText('Generate')!.click();
    await settle();
    expect(calls).toHaveLength(0);
    expect(errorBlock()?.textContent).toContain('Describe the query you want first.');
  });
});

describe('the unavailable state explains how to enable it (AC-3)', () => {
  it('shows the setup steps when the bridge is offline', async () => {
    await openRunner({
      bridgeResponse: {
        ok: false,
        requestId: 'r1',
        error: 'Localhost transport failed: connection refused',
        code: 'BRIDGE_OFFLINE',
      },
    });
    await generate();
    const text = errorBlock()!.textContent ?? '';
    // The org/bridge's own words are kept…
    expect(text).toContain('connection refused');
    // …and our steps are appended as their own node, not concatenated into it.
    expect(text).toContain('sfdt ui');
    expect(text).toContain('features.ai');
    expect(errorBlock()!.getAttribute('role')).toBe('alert');
    expect(errorBlock()!.querySelectorAll('.sfdt-sf-error-note').length).toBeGreaterThan(0);
  });

  it('shows them when the CLI has AI switched off for the project', async () => {
    await openRunner({
      bridgeResponse: {
        ok: false,
        requestId: 'r1',
        error: 'AI features are disabled for this project. Set "features.ai": true in .sfdt/config.json.',
        code: 'REQUEST_INVALID',
      },
    });
    await generate();
    const text = errorBlock()!.textContent ?? '';
    expect(text).toContain('AI features are disabled for this project');
    expect(text).toContain('.sfdt/config.json');
  });

  it('shows them when the token has not been paired', async () => {
    await openRunner({
      bridgeResponse: {
        ok: false,
        requestId: 'r1',
        error: 'Bridge token not configured. Open the extension options page to pair with sfdt.',
        code: 'BRIDGE_UNAUTHORIZED',
      },
    });
    await generate();
    expect(errorBlock()!.textContent).toContain('options page');
    expect(errorBlock()!.textContent).toContain('sfdt ui');
  });

  it('survives a transport that threw rather than answered', async () => {
    await openRunner({ bridgeThrows: new Error('native host disconnected') });
    await generate();
    expect(errorBlock()!.textContent).toContain('native host disconnected');
    expect(errorBlock()!.textContent).toContain('sfdt ui');
    // And the button comes back, so the user can retry.
    expect(byText('Generate')!.disabled).toBe(false);
  });

  it('does not lie about a plain provider failure by offering setup steps', async () => {
    await openRunner({
      bridgeResponse: { ok: false, requestId: 'r1', error: 'AI request failed: rate limited', code: 'INTERNAL_ERROR' },
    });
    await generate();
    const text = errorBlock()!.textContent ?? '';
    expect(text).toContain('rate limited');
    expect(text).not.toContain('sfdt ui');
  });
});

describe('accessibility and keyboard path (CONVENTIONS.md)', () => {
  it('labels every control and states the trade before it is made', async () => {
    await openRunner();
    generateTrigger()!.click();
    expect(panel()!.getAttribute('role')).toBe('group');
    expect(requestBox().getAttribute('aria-label')).toBe('Describe the query you want');
    expect(objectsBox().getAttribute('aria-label')).toContain('Salesforce objects');
    expect(byText('Generate')!.getAttribute('aria-label')).toBe(
      'Generate SOQL from this description',
    );
    expect(byText('Close')!.getAttribute('aria-label')).toBe('Close the query generator');
    const disclosure = document.getElementById(requestBox().getAttribute('aria-describedby')!)!;
    expect(disclosure.textContent).toContain('never run for you');
  });

  it('moves focus into the panel on open and back to the trigger on Escape', async () => {
    await openRunner();
    const trigger = generateTrigger()!;
    trigger.click();
    expect(document.activeElement).toBe(requestBox());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel()!.style.display).toBe('none');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    // The trigger is never disabled, so the restore actually lands.
    expect(trigger.disabled).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('leaves Escape to the modal shell when focus is not in the panel', async () => {
    await openRunner();
    generateTrigger()!.click();
    editorBox().focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    // The panel did NOT claim the key: the modal shell closed the whole runner,
    // exactly as it did before this feature existed. An open disclosure inside
    // a modal must not quietly change what Escape means in the editor.
    expect(panel()).toBeNull();
    expect(document.querySelector('textarea.sfdt-editor-input')).toBeNull();
  });

  it('Close returns focus to the trigger too', async () => {
    await openRunner();
    generateTrigger()!.click();
    byText('Close')!.click();
    expect(document.activeElement).toBe(generateTrigger());
    expect(panel()!.style.display).toBe('none');
  });

  it('hands focus to the EDITOR after a successful generation, never to a disabled control', async () => {
    await openRunner();
    await generate();
    expect(panel()!.style.display).toBe('none');
    expect(document.activeElement).toBe(editorBox());
    expect(editorBox().disabled).toBe(false);
    expect(generateTrigger()!.disabled).toBe(false);
  });

  it('closes the panel and disables the trigger in SOSL mode, with focus left somewhere real', async () => {
    await openRunner();
    generateTrigger()!.click();
    expect(panel()!.style.display).toBe('flex');

    byText('SOSL')!.click();
    await settle();
    expect(panel()!.style.display).toBe('none');
    expect(generateTrigger()!.disabled).toBe(true);
    expect(generateTrigger()!.title).toContain('SOQL-only');
    // The SOSL radio took the focus (setLang focuses the chosen radio) — the
    // point is that focus was NOT parked on the control we just disabled.
    expect(document.activeElement).not.toBe(generateTrigger());

    byText('SOQL')!.click();
    await settle();
    expect(generateTrigger()!.disabled).toBe(false);
  });

  it('does not promise a menu it cannot deliver', async () => {
    // aria-haspopup="true" is defined as "opens a MENU". This opens a
    // role="group" form. aria-expanded + aria-controls is the disclosure
    // pattern and is complete without it.
    await openRunner();
    expect(generateTrigger()!.hasAttribute('aria-haspopup')).toBe(false);
    expect(generateTrigger()!.getAttribute('aria-expanded')).toBe('false');
    expect(generateTrigger()!.getAttribute('aria-controls')).toBe(panel()!.id);
  });

  it('renders through the shared error funnel, with no hand-rolled console block', async () => {
    await openRunner({ bridgeResponse: { ok: false, requestId: 'r', error: 'nope', code: 'BRIDGE_OFFLINE' } });
    await generate();
    const block = errorBlock()!;
    expect(block.classList.contains('sfdt-console')).toBe(true);
    expect(block.classList.contains('sfdt-error')).toBe(true);
    expect(block.getAttribute('role')).toBe('alert');
    // The org's text and each of our lines are separate nodes (PR #308).
    expect(block.querySelector('.sfdt-sf-error-text')?.textContent).toBe('nope');
  });

  it('uses design tokens only — no raw colour literal anywhere in the panel', async () => {
    await openRunner();
    generateTrigger()!.click();
    const inline = Array.from(panel()!.querySelectorAll<HTMLElement>('*'))
      .map((el) => el.getAttribute('style') ?? '')
      .concat(panel()!.getAttribute('style') ?? '')
      .join(' ');
    expect(inline).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(inline).not.toMatch(/\brgba?\(/i);
  });
});

// ---------------------------------------------------------------------------
// Regression: N4. A generation is a multi-second round trip and the runner
// stays live throughout it, so the user can walk away from it — switch the
// editor to SOSL and type a FIND, dismiss the generator, close the runner.
// The success path used to check `nlGenerateBtn.disabled` only at the START,
// so whatever came back afterwards was written into the editor regardless,
// destroying the query the user typed instead and silently flipping the
// language back. Each test below fails against the unguarded success path.

/** Open a runner whose bridge hangs until the returned `release()` is called. */
async function openRunnerWithHungBridge(): Promise<{
  release: () => void;
  calls: unknown[];
}> {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: unknown[] = [];
  await patchSettings({ features: { [SOQL_NL_GENERATE_ID]: true } });
  const bridge = {
    call: vi.fn(async (request: unknown) => {
      calls.push(request);
      await gate;
      return {
        ok: true,
        requestId: 'r',
        data: { response: '```soql\nSELECT Id FROM Account LIMIT 1\n```', provider: 'claude' },
      };
    }),
  };
  const feature = createSoqlRunnerFeature({
    api: fakeApi(),
    bridgeFactory: async () => bridge as never,
  });
  await feature.onActivate?.();
  await settle();

  generateTrigger()!.click();
  requestBox().value = 'all accounts';
  byText('Generate')!.click();
  await settle();
  expect(calls).toHaveLength(1);
  return { release: () => release!(), calls };
}

describe('a generation the user walked away from does not land (N4)', () => {
  it('does not overwrite the SOSL query typed while it was in flight', async () => {
    const { release } = await openRunnerWithHungBridge();

    // The user gives up on the generator and writes a SOSL search by hand.
    byText('SOSL')!.click();
    await settle();
    editorBox().value = 'FIND {Acme} IN ALL FIELDS';
    expect(panel()!.style.display).toBe('none');

    release();
    await settle(10);

    // Their query survives, and the language toggle did not flip back.
    expect(editorBox().value).toBe('FIND {Acme} IN ALL FIELDS');
    expect(byText('SOSL')!.getAttribute('aria-checked')).toBe('true');
    expect(byText('SOQL')!.getAttribute('aria-checked')).toBe('false');
    // The panel stayed shut and the trigger stayed unavailable — no half-open
    // state left behind by an outcome that was never applied.
    expect(panel()!.style.display).toBe('none');
    expect(generateTrigger()!.disabled).toBe(true);
  });

  it('does not overwrite the draft after the user closed the generator', async () => {
    const { release } = await openRunnerWithHungBridge();

    editorBox().value = 'SELECT Id FROM Contact';
    byText('Close')!.click();

    release();
    await settle(10);

    expect(editorBox().value).toBe('SELECT Id FROM Contact');
    expect(panel()!.style.display).toBe('none');
  });

  it('writes nothing anywhere after the runner was closed', async () => {
    const { release } = await openRunnerWithHungBridge();

    // Escape from the editor closes the whole view (the modal shell's own key).
    editorBox().focus();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    await settle();
    expect(document.querySelector('textarea.sfdt-editor-input')).toBeNull();

    release();
    await settle(10);

    // Nothing was resurrected, and nothing threw on the way past. The toast is
    // the load-bearing assertion: the editor write lands on a detached node and
    // is invisible either way, but the success path also announces itself into
    // the LIVE document, so an unguarded late success is still user-visible —
    // a "Query generated" toast for a runner that is not on screen.
    expect(document.querySelector('textarea.sfdt-editor-input')).toBeNull();
    expect(panel()).toBeNull();
    expect(document.body.textContent).not.toContain('Query generated');
  });

  it('is not vacuous: the untouched case still lands in the editor', async () => {
    // Same harness, same hung bridge — the ONLY difference is that the user
    // waited. If the guard were simply "never write", the three tests above
    // would pass for the wrong reason and this one would fail.
    const { release } = await openRunnerWithHungBridge();
    release();
    await settle(10);
    expect(editorBox().value).toBe('SELECT Id FROM Account LIMIT 1');
  });
});

describe('re-entrancy', () => {
  it('will not start a second generation while one is in flight', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const api = fakeApi();
    await patchSettings({ features: { [SOQL_NL_GENERATE_ID]: true } });
    const calls: unknown[] = [];
    const bridge = {
      call: vi.fn(async (request: unknown) => {
        calls.push(request);
        await gate;
        return {
          ok: true,
          requestId: 'r',
          data: { response: 'SELECT Id FROM Account', provider: 'claude' },
        };
      }),
    };
    const feature = createSoqlRunnerFeature({ api, bridgeFactory: async () => bridge as never });
    await feature.onActivate?.();
    await settle();

    generateTrigger()!.click();
    requestBox().value = 'all accounts';
    byText('Generate')!.click();
    await settle();
    // The in-panel button is disabled while running — and it is the ONLY thing
    // disabled, so nothing is stranding focus.
    const running = panel()!.querySelector('button') as HTMLButtonElement;
    expect(running.disabled).toBe(true);
    expect(generateTrigger()!.disabled).toBe(false);
    running.click();
    await settle();
    expect(calls).toHaveLength(1);

    release!();
    await settle(10);
    expect(editorBox().value).toBe('SELECT Id FROM Account');
    expect(running.disabled).toBe(false);
  });
});
