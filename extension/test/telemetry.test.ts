import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTelemetry, type TelemetrySnapshot } from '../lib/telemetry.js';

describe('telemetry', () => {
  beforeEach(() => {
    chrome.storage.local.clear();
  });

  it('records nothing when opt-in is false', async () => {
    const t = createTelemetry({ isEnabled: () => false });
    await t.track('feature.activated', { featureId: 'canvas-search' });
    const snapshot = await t.snapshot();
    expect(snapshot.counters).toEqual({});
  });

  it('increments counters when opt-in is true', async () => {
    const t = createTelemetry({ isEnabled: () => true });
    await t.track('feature.activated', { featureId: 'canvas-search' });
    await t.track('feature.activated', { featureId: 'canvas-search' });
    await t.track('feature.errored', { featureId: 'canvas-search' });
    const { counters } = await t.snapshot();
    expect(counters['canvas-search']).toEqual({
      activated: 2,
      errored: 1,
      disabled_remote: 0,
    });
  });

  it('rotates counters on a new month', async () => {
    const clock = { now: new Date('2026-05-15T10:00:00Z') };
    const t = createTelemetry({ isEnabled: () => true, now: () => clock.now });
    await t.track('feature.activated', { featureId: 'canvas-search' });
    expect((await t.snapshot()).monthKey).toBe('2026-05');

    clock.now = new Date('2026-06-01T00:00:00Z');
    await t.track('feature.activated', { featureId: 'flow-deploy' });
    const snapshot = await t.snapshot();
    expect(snapshot.monthKey).toBe('2026-06');
    expect(snapshot.counters).toEqual({
      'flow-deploy': { activated: 1, errored: 0, disabled_remote: 0 },
    });
  });

  it('caps the number of distinct feature ids at 500', async () => {
    const t = createTelemetry({ isEnabled: () => true });
    for (let i = 0; i < 502; i += 1) {
      await t.track('feature.activated', { featureId: `f-${i}` });
    }
    const { counters } = await t.snapshot();
    expect(Object.keys(counters).length).toBe(500);
  });

  it('logs feature.disabled.remote events', async () => {
    const t = createTelemetry({ isEnabled: () => true });
    await t.track('feature.disabled.remote', { featureId: 'canvas-search' });
    const { counters } = await t.snapshot();
    expect(counters['canvas-search']!.disabled_remote).toBe(1);
  });

  describe('trackBridgeFailure', () => {
    it('records nothing when opt-in is false', async () => {
      const t = createTelemetry({ isEnabled: () => false });
      await t.trackBridgeFailure('offline');
      const snapshot = await t.snapshot();
      expect(snapshot.bridge).toBeUndefined();
    });

    it('increments per-category bridge counters when opted in', async () => {
      const t = createTelemetry({ isEnabled: () => true });
      await t.trackBridgeFailure('offline');
      await t.trackBridgeFailure('offline');
      await t.trackBridgeFailure('unauthorized');
      const snapshot = await t.snapshot();
      expect(snapshot.bridge).toEqual({ offline: 2, unauthorized: 1 });
    });

    it('keeps feature counters and bridge counters in the same monthly snapshot', async () => {
      const t = createTelemetry({ isEnabled: () => true });
      await t.track('feature.activated', { featureId: 'canvas-search' });
      await t.trackBridgeFailure('timeout');
      const snapshot = await t.snapshot();
      expect(snapshot.counters['canvas-search']?.activated).toBe(1);
      expect(snapshot.bridge?.timeout).toBe(1);
    });
  });

  describe('pushSnapshot', () => {
    it('is a no-op (returns false) when telemetry is opted out', async () => {
      const t = createTelemetry({ isEnabled: () => false });
      const pusher = vi.fn(async (_snap: TelemetrySnapshot) => true);
      const result = await t.pushSnapshot(pusher);
      expect(result).toBe(false);
      expect(pusher).not.toHaveBeenCalled();
    });

    it('passes the current snapshot to the pusher when opted in', async () => {
      const t = createTelemetry({ isEnabled: () => true });
      await t.track('feature.activated', { featureId: 'canvas-search' });
      const pusher = vi.fn(async (_snap: TelemetrySnapshot) => true);
      const result = await t.pushSnapshot(pusher);
      expect(result).toBe(true);
      expect(pusher).toHaveBeenCalledOnce();
      const snap = pusher.mock.calls[0]?.[0];
      expect(snap?.counters['canvas-search']?.activated).toBe(1);
    });

    it('returns false when the pusher throws (best-effort)', async () => {
      const t = createTelemetry({ isEnabled: () => true });
      const result = await t.pushSnapshot(async () => {
        throw new Error('network down');
      });
      expect(result).toBe(false);
    });
  });

  describe('legacy key migration', () => {
    it('reads and migrates counters from the legacy sfut.telemetry key', async () => {
      const now = () => new Date('2026-05-20T10:00:00Z');
      chrome.storage.local.set({
        'sfut.telemetry': {
          monthKey: '2026-05',
          counters: { 'canvas-search': { activated: 3, errored: 1, disabled_remote: 0 } },
        } satisfies TelemetrySnapshot,
      } as any);
      const t = createTelemetry({ isEnabled: () => true, now });
      const snapshot = await t.snapshot();
      expect(snapshot.counters['canvas-search']).toEqual({ activated: 3, errored: 1, disabled_remote: 0 });
      // Migrated forward: new key written, legacy key removed.
      const after = await new Promise<any>((r) => chrome.storage.local.get(['sfdt.telemetry', 'sfut.telemetry'], r));
      expect(after['sfdt.telemetry']).toBeDefined();
      expect(after['sfut.telemetry']).toBeUndefined();
    });
  });
});
