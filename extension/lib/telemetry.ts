const STORAGE_KEY = 'sfut.telemetry';
const MAX_FEATURE_IDS = 500;
export type TelemetryEvent =
  | 'feature.activated'
  | 'feature.errored'
  | 'feature.disabled.remote';
export interface FeatureCounter {
  activated: number;
  errored: number;
  disabled_remote: number;
}
export interface TelemetrySnapshot {
  monthKey: string;
  counters: Record<string, FeatureCounter>;
}
export interface Telemetry {
  track(event: TelemetryEvent, data: { featureId: string }): Promise<void>;
  snapshot(): Promise<TelemetrySnapshot>;
}
function monthKeyOf(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
function emptyCounter(): FeatureCounter {
  return { activated: 0, errored: 0, disabled_remote: 0 };
}
async function read(): Promise<TelemetrySnapshot | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const raw = result?.[STORAGE_KEY] as TelemetrySnapshot | undefined;
      if (
        !raw ||
        typeof raw.monthKey !== 'string' ||
        !raw.counters ||
        typeof raw.counters !== 'object'
      ) {
        return resolve(null);
      }
      resolve(raw);
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
    async snapshot() {
      const existing = await read();
      const today = monthKeyOf(now());
      if (!existing || existing.monthKey !== today) {
        return { monthKey: today, counters: {} };
      }
      return existing;
    },
  };
}
