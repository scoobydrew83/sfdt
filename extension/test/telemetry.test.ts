import { describe, it, expect, beforeEach } from 'vitest';
import { createTelemetry } from '../lib/telemetry.js';
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
});
