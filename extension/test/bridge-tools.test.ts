import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createDriftFeature,
  createScanFeature,
  createCompareFeature,
  _bridgeToolsTestApi,
} from '../features/bridge-tools.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SfdtResponse } from '@sfdt/flow-core/bridge-contract';

function clearBody(): void {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
}

function fakeBridge(response: SfdtResponse) {
  return { call: vi.fn((_req: unknown, _opts?: unknown) => Promise.resolve(response)) };
}

function setText(placeholderIncludes: string, value: string): void {
  const input = [...document.querySelectorAll('input[type="text"]')].find((i) =>
    (i as HTMLInputElement).placeholder.includes(placeholderIncludes),
  ) as HTMLInputElement;
  input.value = value;
}

function clickRun(label: string): void {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === label)!;
  btn.click();
}

beforeEach(clearBody);

describe('bridgeErrorHint', () => {
  const { bridgeErrorHint } = _bridgeToolsTestApi();
  it('maps each known code to a hint and unknown codes to empty', () => {
    expect(bridgeErrorHint({ ok: false, requestId: 'r', error: 'x', code: 'BRIDGE_OFFLINE' })).toContain('sfdt ui');
    expect(bridgeErrorHint({ ok: false, requestId: 'r', error: 'x', code: 'BRIDGE_UNAUTHORIZED' })).toContain('bridge-token');
    expect(bridgeErrorHint({ ok: false, requestId: 'r', error: 'x', code: 'NOT_IMPLEMENTED' })).toContain('not wired up');
    expect(bridgeErrorHint({ ok: false, requestId: 'r', error: 'x' })).toBe('');
  });
});

describe('drift feature', () => {
  it('calls the bridge with the entered component and renders the result', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: { drifted: true } });
    const feature = createDriftFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    setText('Component', 'Account.MyField__c');
    clickRun('Check drift');

    await vi.waitFor(() => expect(document.body.textContent).toContain('drifted'));
    expect(bridge.call.mock.calls[0]![0]).toEqual({
      kind: 'drift',
      component: 'Account.MyField__c',
      refresh: false, // "Run live" checkbox unchecked → snapshot
    });
  });

  it('sends refresh:true when "Run live" is checked', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: { drifted: false } });
    const feature = createDriftFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    setText('Component', 'Account.MyField__c');
    (document.querySelector('input[type="checkbox"]') as HTMLInputElement).checked = true;
    clickRun('Check drift');
    await vi.waitFor(() => expect(bridge.call).toHaveBeenCalled());
    expect((bridge.call.mock.calls[0]![0] as { refresh: boolean }).refresh).toBe(true);
  });

  it('shows the offline hint when the bridge is down', async () => {
    const bridge = fakeBridge({ ok: false, requestId: 'r', error: 'bridge offline', code: 'BRIDGE_OFFLINE' });
    const feature = createDriftFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    setText('Component', 'X');
    clickRun('Check drift');

    await vi.waitFor(() => expect(document.body.textContent).toContain('bridge offline'));
    expect(document.body.textContent).toContain('sfdt ui');
  });
});

describe('scan feature', () => {
  it('sends the selected scanType', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: { scanned: 3 } });
    const feature = createScanFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    clickRun('Scan');

    await vi.waitFor(() => expect(document.body.textContent).toContain('scanned'));
    expect(bridge.call.mock.calls[0]![0]).toEqual({ kind: 'scan', scanType: 'scheduled' });
  });
});

describe('compare feature', () => {
  it('validates that both sides are provided', async () => {
    const bridge = fakeBridge({ ok: true, requestId: 'r', data: {} });
    const feature = createCompareFeature({ bridgeFactory: async () => bridge });
    await feature.onActivate?.();
    setText('Source', 'dev');
    // Leave target empty.
    clickRun('Compare');

    await vi.waitFor(() => expect(document.body.textContent).toContain('both a source and target'));
    expect(bridge.call).not.toHaveBeenCalled();
  });
});

// flow-quality is now a DIRECT feature (no bridge) — see flow-quality.test.ts.
