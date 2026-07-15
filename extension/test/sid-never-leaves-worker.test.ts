// Guard test for P0-4: the Salesforce `sid` must never enter page-adjacent
// memory. Feature code, UI code, and non-worker entrypoints must reach the org
// only through the worker-brokered `sfApiFetch` route — never read the sid
// cookie, never call the getSidForUrls route, never attach a raw
// `Authorization: Bearer` header themselves.
//
// The ONE documented, temporary exception is the Event Streaming Monitor
// (features/event-monitor.ts): its CometD long-poll client still needs the raw
// sid (via api.getSessionDetails()) to open its own connection. That path is
// migrated to a worker-brokered connection in PR2, at which point this
// allowlist entry is removed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { sfApiFetch } from '../lib/sf-api-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, '..');

// Files under these roots are page-adjacent and must be sid-free.
const SCANNED_ROOTS = [
  path.join(EXT_ROOT, 'features'),
  path.join(EXT_ROOT, 'ui'),
  path.join(EXT_ROOT, 'entrypoints', 'app'),
  path.join(EXT_ROOT, 'entrypoints', 'options'),
];
const SCANNED_FILES = [path.join(EXT_ROOT, 'entrypoints', 'content.ts')];

// Temporary allowlist — removed in PR2. See file header.
const ALLOWLIST = new Set([path.join(EXT_ROOT, 'features', 'event-monitor.ts')]);

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

function allScannedFiles(): string[] {
  const files = [...SCANNED_FILES];
  for (const root of SCANNED_ROOTS) {
    files.push(...collectTsFiles(root));
  }
  return files.filter((f) => !ALLOWLIST.has(f));
}

// Bans a raw Bearer auth header on a fetch — the worker owns Authorization.
const BEARER_RE = /Authorization[^\n]*Bearer/;

describe('sid never leaves the worker (P0-4 guard)', () => {
  const files = allScannedFiles();

  it('scans a non-trivial set of page-adjacent files', () => {
    // Sanity: if the glob broke and matched nothing, the assertions below would
    // pass vacuously. Anchor a floor so a mis-wired scan fails loudly.
    expect(files.length).toBeGreaterThan(20);
  });

  it('no feature/UI/entrypoint code reads the sid cookie', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('chrome.cookies'));
    expect(offenders).toEqual([]);
  });

  it('no feature/UI/entrypoint code calls the getSidForUrls route', () => {
    const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('getSidForUrls'));
    expect(offenders).toEqual([]);
  });

  it('no feature/UI/entrypoint code attaches a raw Authorization: Bearer header', () => {
    const offenders = files.filter((f) => BEARER_RE.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });

  it('the one allowlisted exception (event-monitor) is real and still present', () => {
    // If event-monitor is refactored away, this reminds us to drop the allowlist.
    const src = readFileSync(path.join(EXT_ROOT, 'features', 'event-monitor.ts'), 'utf8');
    expect(src).toContain('getSessionDetails');
  });

  it('an sfApiFetch worker response carries NO sid field', async () => {
    const cookieGet = async (): Promise<string> => 'THE-SECRET-SID';
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        async text() {
          return '{"records":[]}';
        },
      }) as unknown as Response) as typeof fetch;

    const resp = await sfApiFetch(
      { kind: 'json', method: 'GET', endpoint: '/services/data', targetOrigin: 'https://acme.lightning.force.com' },
      { fetchImpl, cookieGet },
    );

    expect(resp.ok).toBe(true);
    // The whole serialized response must not leak the sid anywhere.
    const serialized = JSON.stringify(resp);
    expect(serialized).not.toContain('THE-SECRET-SID');
    expect(serialized.toLowerCase()).not.toContain('"sid"');
    expect(serialized).not.toContain('Authorization');
    if (resp.ok) {
      expect(resp.bodyText).toBe('{"records":[]}');
      expect(Object.keys(resp)).not.toContain('sid');
    }
  });
});
