// Opt-in, local-only — no network egress. The data exists so the user
// (or support) can see which features run in this browser profile.

const STORAGE_KEY = 'sfdt.telemetry';
// Legacy "SFUT"-era key; migrated forward on first read so opt-in counters survive.
const LEGACY_STORAGE_KEY = 'sfut.telemetry';
const MAX_FEATURE_IDS = 500;

export type TelemetryEvent =
  | 'feature.activated'
  | 'feature.errored'
  | 'feature.disabled.remote';

/**
 * Coarse transport-health buckets for bridge call failures.
 *   offline      — bridge endpoint unreachable (BRIDGE_OFFLINE)
 *   timeout      — request aborted / native host timed out
 *   unauthorized — bearer token missing/invalid or origin rejected
 *   protocol     — refused locally after a major protocol-version mismatch
 *   other        — any other bridge error code
 */
export type BridgeFailureCategory =
  | 'offline'
  | 'timeout'
  | 'unauthorized'
  | 'protocol'
  | 'other';

export interface FeatureCounter {
  activated: number;
  errored: number;
  disabled_remote: number;
}

export interface TelemetrySnapshot {
  monthKey: string;
  counters: Record<string, FeatureCounter>;
  /** Bridge failure counts by category. Absent on snapshots written before
   * bridge tracking existed — readers treat undefined as all-zero. */
  bridge?: Partial<Record<BridgeFailureCategory, number>>;
}

export interface Telemetry {
  track(event: TelemetryEvent, data: { featureId: string }): Promise<void>;
  /**
   * Counts a bridge transport failure. MUST never be fed by telemetry's own
   * bridge traffic (the bridge layer filters `telemetry.*` kinds before
   * emitting) — otherwise a dead bridge would count its own push failures.
   */
  trackBridgeFailure(category: BridgeFailureCategory): Promise<void>;
  snapshot(): Promise<TelemetrySnapshot>;
  /**
   * No-op when telemetry is opt-out. Returns true when the bridge accepted
   * the snapshot. The pusher is injected so this module stays import-free
   * of sfdt-bridge.
   */
  pushSnapshot(pusher: SnapshotPusher): Promise<boolean>;
}

export type SnapshotPusher = (snapshot: TelemetrySnapshot) => Promise<boolean>;

function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function emptyCounter(): FeatureCounter {
  return { activated: 0, errored: 0, disabled_remote: 0 };
}

function isValidSnapshot(raw: TelemetrySnapshot | undefined): raw is TelemetrySnapshot {
  return !!raw && typeof raw.monthKey === 'string' && !!raw.counters && typeof raw.counters === 'object';
}

async function read(): Promise<TelemetrySnapshot | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get([STORAGE_KEY, LEGACY_STORAGE_KEY], (result) => {
      const current = result?.[STORAGE_KEY] as TelemetrySnapshot | undefined;
      if (isValidSnapshot(current)) return resolve(current);
      // One-time migration from the legacy sfut.* key.
      const legacy = result?.[LEGACY_STORAGE_KEY] as TelemetrySnapshot | undefined;
      if (isValidSnapshot(legacy)) {
        chrome.storage.local.set({ [STORAGE_KEY]: legacy }, () => {
          chrome.storage.local.remove(LEGACY_STORAGE_KEY, () => resolve(legacy));
        });
        return;
      }
      resolve(null);
    });
  });
}

async function write(snapshot: TelemetrySnapshot): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: snapshot }, () => resolve());
  });
}

export function createTelemetry(opts: {
  isEnabled: () => boolean;
  now?: () => Date;
}): Telemetry {
  const now = opts.now ?? (() => new Date());

  return {
    async track(event, data) {
      if (!opts.isEnabled()) return;
      const today = monthKeyOf(now());
      const existing = await read();
      const snapshot: TelemetrySnapshot =
        existing && existing.monthKey === today
          ? existing
          : { monthKey: today, counters: {} };
      const id = data.featureId;
      if (!snapshot.counters[id]) {
        if (Object.keys(snapshot.counters).length >= MAX_FEATURE_IDS) return;
        snapshot.counters[id] = emptyCounter();
      }
      const counter = snapshot.counters[id];
      if (event === 'feature.activated') counter.activated += 1;
      else if (event === 'feature.errored') counter.errored += 1;
      else if (event === 'feature.disabled.remote') counter.disabled_remote += 1;
      await write(snapshot);
    },

    async trackBridgeFailure(category) {
      if (!opts.isEnabled()) return;
      const today = monthKeyOf(now());
      const existing = await read();
      const snapshot: TelemetrySnapshot =
        existing && existing.monthKey === today
          ? existing
          : { monthKey: today, counters: {} };
      const bridge = snapshot.bridge ?? {};
      bridge[category] = (bridge[category] ?? 0) + 1;
      snapshot.bridge = bridge;
      await write(snapshot);
    },

    async snapshot() {
      const existing = await read();
      const today = monthKeyOf(now());
      if (!existing || existing.monthKey !== today) {
        return { monthKey: today, counters: {} };
      }
      return existing;
    },

    async pushSnapshot(pusher) {
      if (!opts.isEnabled()) return false;
      const existing = await read();
      const today = monthKeyOf(now());
      const snap: TelemetrySnapshot =
        existing && existing.monthKey === today
          ? existing
          : { monthKey: today, counters: {} };
      try {
        return await pusher(snap);
      } catch {
        return false;
      }
    },
  };
}
