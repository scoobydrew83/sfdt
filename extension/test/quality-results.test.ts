// C-P5-1 — the Quality Results panel. Covers the bridge call shape, the three
// render states (results / skipped / no-run), the severity + engine filters,
// the absent-bridge message, and the Setup deep link.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';
import {
  createQualityResultsFeature,
  buildComponentIdQuery,
  statusLabel,
} from '../features/quality-results.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import { SalesforceApiClient, type MessageBus } from '../lib/salesforce-api.js';

function clearBody(): void {
  document.body.replaceChildren();
  setWorkspaceViewSink(null);
  window.history.replaceState(
    {},
    '',
    'https://x.lightning.force.com/lightning/setup/SetupOneHome/home',
  );
}

beforeEach(clearBody);

function fakeBridge(response: SfdtResponse) {
  return { call: vi.fn((_req: unknown, _opts?: unknown) => Promise.resolve(response)) };
}

/** A client whose worker answers every Tooling query with `records`. */
function makeApi(records: unknown[]): SalesforceApiClient {
  const bus: MessageBus = {
    sendMessage: (async (msg: { action?: string }) => {
      if (msg.action !== 'sfApiFetch') return { ok: true, sids: {} };
      return {
        ok: true,
        status: 200,
        bodyText: JSON.stringify({ size: records.length, done: true, records }),
        contentType: 'application/json',
        baseUrl: 'https://x.my.salesforce.com',
      };
    }) as unknown as MessageBus['sendMessage'],
  };
  return new SalesforceApiClient({
    win: {
      location: {
        hostname: 'x.lightning.force.com',
        origin: 'https://x.lightning.force.com',
        search: '',
      },
    } as never,
    messageBus: bus,
  });
}

const RUN = {
  available: true,
  timestamp: '2026-08-28T10:00:00.000Z',
  status: 'FAIL',
  summary: { critical: 1, high: 0, medium: 0, low: 1 },
  violations: [
    {
      file: 'force-app/main/default/classes/AccountService.cls',
      line: 42,
      rule: 'ApexCRUDViolation',
      engine: 'pmd',
      severity: 1,
      message: 'Validate CRUD permission before SOQL/DML operation.',
    },
    {
      file: 'force-app/main/default/lwc/accountCard/accountCard.js',
      line: 12,
      rule: 'no-unused-vars',
      engine: 'eslint',
      severity: 4,
      message: "'foo' is assigned a value but never used.",
    },
  ],
  unavailableMessage: null,
};

function selects(): HTMLSelectElement[] {
  return [...document.querySelectorAll('select')] as HTMLSelectElement[];
}

function buttonLabelled(text: string): HTMLButtonElement {
  return [...document.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes(text),
  ) as HTMLButtonElement;
}

describe('quality-results — manifest and pure helpers', () => {
  it('registers a stable id', () => {
    expect(createQualityResultsFeature().manifest.id).toBe('quality-results');
  });

  it('builds the Tooling lookup only for types that have one', () => {
    expect(
      buildComponentIdQuery({ toolingObject: 'ApexClass', setupNode: 'ApexClasses', name: 'Foo' }),
    ).toBe("SELECT Id FROM ApexClass WHERE Name = 'Foo' LIMIT 1");
    expect(
      buildComponentIdQuery({
        toolingObject: 'LightningComponentBundle',
        setupNode: 'LightningComponentBundles',
        name: 'myCmp',
      }),
    ).toBe("SELECT Id FROM LightningComponentBundle WHERE DeveloperName = 'myCmp' LIMIT 1");
    expect(buildComponentIdQuery({ toolingObject: null, setupNode: 'Flows', name: 'F' })).toBeNull();
  });

  it('escapes a quote in a component name rather than breaking the SOQL', () => {
    const soql = buildComponentIdQuery({
      toolingObject: 'ApexClass',
      setupNode: 'ApexClasses',
      name: "O'Brien",
    });
    expect(soql).toBe("SELECT Id FROM ApexClass WHERE Name = 'O\\'Brien' LIMIT 1");
  });

  it('never labels a skipped scan as a pass', () => {
    expect(statusLabel('PASS')).toBe('Pass');
    expect(statusLabel('SKIPPED')).toBe('Scan skipped');
    expect(statusLabel('UNAVAILABLE')).toBe('No run recorded');
  });
});

describe('quality-results — rendering a recorded run', () => {
  it('asks the bridge for the read-only quality.results kind on open', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: RUN });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalled());
    expect(bridge.call.mock.calls[0]![0]).toEqual({ kind: 'quality.results' });
  });

  it('renders per-file groups with rule id, message and engine attribution', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: RUN });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() => expect(document.body.textContent).toContain('AccountService.cls'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('ApexCRUDViolation');
    expect(text).toContain('Validate CRUD permission');
    expect(text).toContain('pmd');
    expect(text).toContain('accountCard.js');
    expect(text).toContain('no-unused-vars');
    expect(text).toContain('eslint');
    expect(text).toContain('Issues found');
  });

  it('offers a severity filter and an engine filter built from the run', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: RUN });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('AccountService.cls'));

    const severity = selects()[0]!;
    const engine = selects()[1]!;
    expect([...severity.options].map((o) => o.value)).toEqual([
      '',
      'critical',
      'high',
      'medium',
      'low',
    ]);
    expect([...engine.options].map((o) => o.value)).toEqual(['', 'eslint', 'pmd']);

    severity.value = 'critical';
    severity.dispatchEvent(new Event('change'));
    expect(document.body.textContent).toContain('AccountService.cls');
    expect(document.body.textContent).not.toContain('accountCard.js');

    engine.value = 'eslint';
    engine.dispatchEvent(new Event('change'));
    expect(document.body.textContent).toContain('No issues match the current filters');
  });

  it('opens the class in Setup, deep-linking through the resolved record Id', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: RUN });
    const opened: string[] = [];
    const win = {
      location: { href: window.location.href, hostname: 'x.lightning.force.com' },
      open: (url: string) => {
        opened.push(url);
        return null;
      },
    } as unknown as Window;
    const feature = createQualityResultsFeature({
      bridgeFactory: async () => bridge,
      api: makeApi([{ Id: '01p000000000001AAA' }]),
      win,
    });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('AccountService.cls'));

    buttonLabelled('Open in Setup').click();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe(
      'https://x.my.salesforce-setup.com/lightning/setup/ApexClasses/page?address=%2F01p000000000001AAA',
    );
  });

  it('falls back to the Setup list page when the org has no such component', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: RUN });
    const opened: string[] = [];
    const win = {
      location: { href: window.location.href, hostname: 'x.lightning.force.com' },
      open: (url: string) => {
        opened.push(url);
        return null;
      },
    } as unknown as Window;
    const feature = createQualityResultsFeature({
      bridgeFactory: async () => bridge,
      api: makeApi([]),
      win,
    });
    await feature.onActivate?.();
    await vi.waitFor(() => expect(document.body.textContent).toContain('AccountService.cls'));

    buttonLabelled('Open in Setup').click();
    await vi.waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe('https://x.my.salesforce-setup.com/lightning/setup/ApexClasses/home');
  });
});

describe('quality-results — the skipped-analyzer state (J-1 parity)', () => {
  it('says SKIPPED with the reason and never claims a clean result', async () => {
    const bridge = fakeBridge({
      ok: true,
      requestId: 'r',
      data: {
        available: true,
        timestamp: '2026-08-28T10:00:00.000Z',
        status: 'SKIPPED',
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        violations: [],
        unavailableMessage: 'sf code-analyzer not installed',
      },
    });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() => expect(document.body.textContent).toContain('SKIPPED'));
    const text = document.body.textContent ?? '';
    expect(text).toContain('sf code-analyzer not installed');
    expect(text).toContain('not a clean result');
    // The two phrasings a clean run would use must be absent.
    expect(text).not.toContain('No violations in the last recorded run');
    expect(text).not.toContain('Pass');
  });
});

describe('quality-results — no run and no bridge', () => {
  it('explains how to record a run when the bridge reports none', async () => {
    const bridge = fakeBridge({
      ok: true,
      requestId: 'r',
      data: { available: false, hint: 'No quality results yet — run Quality from the dashboard.' },
    });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('No quality run recorded yet'),
    );
    expect(document.body.textContent).toContain('run Quality from the dashboard');
  });

  it('explains the bridge setup when the bridge is offline', async () => {
    const bridge = fakeBridge({
      ok: false,
      requestId: 'r',
      error: 'bridge offline',
      code: 'BRIDGE_OFFLINE',
    });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() => expect(document.body.textContent).toContain('bridge offline'));
    expect(document.body.textContent).toContain('sfdt ui');
  });

  it('explains pairing when the bridge rejects the token', async () => {
    const bridge = fakeBridge({
      ok: false,
      requestId: 'r',
      error: 'unauthorized',
      code: 'BRIDGE_UNAUTHORIZED',
    });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() => expect(document.body.textContent).toContain('unauthorized'));
    expect(document.body.textContent).toContain('bridge-token');
  });

  it('renders a clean run as a pass', async () => {
    const bridge = fakeBridge({
      ok: true,
      requestId: 'r',
      data: { available: true, status: 'PASS', violations: [], unavailableMessage: null },
    });
    const feature = createQualityResultsFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();

    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('No violations in the last recorded run'),
    );
    expect(document.body.textContent).toContain('Pass');
  });
});
