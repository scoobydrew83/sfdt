const BASE = '/api';

// ─── Response type definitions ────────────────────────────────────────────────

/**
 * @typedef {{ date: string|null, status: string|null, checks: Array<{name:string, status:string, message:string|null}> }} PreflightResult
 * @typedef {{ date: string|null, status: string|null, components: Array<{name:string, type:string, drift:string}> }} DriftResult
 * @typedef {{ date: string|null, source: string|null, target: string|null, items: Array<{type:string, member:string, status:string}> }} CompareResult
 * @typedef {{ date: string, passed: number, failed: number, errors: number, coverage: number|null, duration: number|null }} TestRun
 * @typedef {{ alias: string, username: string }} OrgEntry
 * @typedef {{ name: string, org: string, apiVersion: string, coverageThreshold: number, features: object, version: string }} ProjectInfo
 * @typedef {{ current: string, latest: string, updateAvailable: boolean }} UpdateInfo
 * @typedef {{ name: string, installedVersion: string|null, latestVersion: string|null, latestError: boolean, updateAvailable: boolean, protocolVersion: string|null, description: string|null, cliVersion: string }} FlowCoreInfo
 * @typedef {{ available: boolean, enabled: boolean, provider: string }} AiAvailability
 * @typedef {{ date: string, manifest: string, org: string, dryRun: boolean, skipPreflight: boolean, exitCode: number }} DeployHistoryEntry
 */

/**
 * Build an Error from a failed response, preferring the server's `{ error }`
 * body message over the bare status text so callers can show *why* it failed
 * (e.g. "This config key cannot be set via the API" instead of "403").
 */
async function httpError(res) {
  let detail = '';
  try {
    const body = await res.clone().json();
    if (body && typeof body.error === 'string') detail = body.error;
  } catch { /* non-JSON / empty body */ }
  const err = new Error(detail ? `${res.status} ${detail}` : `${res.status} ${res.statusText}`);
  err.status = res.status;
  err.detail = detail || res.statusText;
  return err;
}

// ─── Auth state ──────────────────────────────────────────────────────────────
// The dashboard authenticates every /api call with a one-time launch token
// (regenerated on each `sfdt ui` start). If that token is missing or stale, the
// CSRF handshake 401s. We must NOT cache that rejection forever (it would brick
// every page), and we must tell the user how to recover.

let csrfTokenPromise = null;
let authExpired = false;
const authListeners = new Set();

/** Subscribe to "dashboard session expired" — returns an unsubscribe fn. */
export function onAuthExpired(cb) {
  authListeners.add(cb);
  if (authExpired) cb();
  return () => authListeners.delete(cb);
}

export function isAuthExpired() {
  return authExpired;
}

function flagAuthExpired() {
  authExpired = true;
  authListeners.forEach((cb) => { try { cb(); } catch { /* ignore */ } });
}

/** Read the launch token from the URL (preferred, self-healing on reload) or
 *  sessionStorage. The token is deliberately left in the URL so a plain reload
 *  re-authenticates — it is localhost-only and already printed by `sfdt ui`. */
function launchToken() {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    sessionStorage.setItem('sfdt_launch_token', fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem('sfdt_launch_token');
}

async function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = (async () => {
      const token = launchToken();
      const res = await fetch(`${BASE}/csrf-token`, {
        headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        // Stale/missing launch token: drop it so a fresh ?token= can replace it,
        // and surface a recoverable "session expired" state to the UI.
        sessionStorage.removeItem('sfdt_launch_token');
        flagAuthExpired();
        throw await httpError(res);
      }
      authExpired = false;
      return (await res.json()).token;
    })();
    // Never memoize a rejected handshake — the next request must retry.
    csrfTokenPromise.catch(() => { csrfTokenPromise = null; });
  }
  return csrfTokenPromise;
}

/** After a 401/403, force a fresh CSRF handshake on the next request — recovers
 *  transparently when only the per-start CSRF token (not the launch token) went
 *  stale, e.g. after the server restarted mid-session. */
function onMaybeAuthError(res) {
  if (res.status === 401 || res.status === 403) csrfTokenPromise = null;
}

// EventSource can't set custom headers — callers that need to start an SSE
// stream against a CSRF-protected endpoint use this to splice the token
// into the URL.
export async function csrfQuery() {
  return `csrf=${encodeURIComponent(await getCsrfToken())}`;
}

async function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-SFDT-CSRF': await getCsrfToken(),
  };
}

/** @returns {Promise<any>} */
async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      'X-SFDT-CSRF': await getCsrfToken(),
    },
  });
  if (!res.ok) { onMaybeAuthError(res); throw await httpError(res); }
  return res.json();
}

/** @returns {Promise<any>} */
async function deleteJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: await jsonHeaders(),
  });
  if (!res.ok) { onMaybeAuthError(res); throw await httpError(res); }
  return res.json();
}

/** @returns {Promise<any>} */
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { onMaybeAuthError(res); throw await httpError(res); }
  return res.json();
}

/** @returns {Promise<any>} */
async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) { onMaybeAuthError(res); throw await httpError(res); }
  return res.json();
}

/** @returns {Promise<any>} */
async function deleteRequest(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'X-SFDT-CSRF': await getCsrfToken() },
  });
  if (!res.ok) { onMaybeAuthError(res); throw await httpError(res); }
  return res.json();
}

export const api = {
  /** @returns {Promise<ProjectInfo>} */
  project:                () => fetchJson('/project'),
  /** @returns {Promise<UpdateInfo>} */
  checkUpdates:           () => fetchJson('/check-updates'),
  /** @returns {Promise<FlowCoreInfo>} */
  flowCoreInfo:           () => fetchJson('/flow-core/info'),
  /** @returns {Promise<{ runs: TestRun[] }>} */
  testRuns:               () => fetchJson('/test-runs'),
  /** @returns {Promise<{ ok: boolean }>} */
  deleteTestRun:          (filename) => deleteJson(`/test-runs/${encodeURIComponent(filename)}`),
  /** @returns {Promise<{ configured: string[], discovered: string[] }>} */
  testClasses:            () => fetchJson('/test/classes'),
  /** @returns {Promise<{ added: number, removed: number, total: number }>} */
  syncTestClasses:        () => postJson('/test/classes/sync', {}),
  /** @returns {Promise<PreflightResult>} */
  preflight:              () => fetchJson('/preflight'),
  /** @returns {Promise<DriftResult>} */
  drift:                  () => fetchJson('/drift'),
  /** Org diagnose/audit snapshot. @returns {Promise<{timestamp:string|null, org:string|null, checks:Array, summary:object}>} */
  audit:                  () => fetchJson('/audit'),
  /** Org monitoring snapshot. @returns {Promise<{timestamp:string|null, org:string|null, checks:Array, summary:object}>} */
  monitor:                () => fetchJson('/monitor'),
  /** @returns {Promise<{date:string|null, status:string|null, summary:{critical:number,high:number,medium:number,low:number}, violations:Array, unavailableMessage:string|null}>} */
  quality:                () => fetchJson('/quality'),
  /** @returns {Promise<{ ok: boolean }>} */
  health:                 () => fetchJson('/health'),
  /** @returns {Promise<{ orgs: OrgEntry[] }>} */
  orgs:                   () => fetchJson('/orgs'),
  /** @returns {Promise<{ org: string|null }>} */
  sessionOrg:             () => fetchJson('/session/org'),
  /** @returns {Promise<{ org: string }>} */
  setSessionOrg:          (org) => postJson('/session/org', { org }),
  /** @returns {Promise<CompareResult>} */
  compareResult:          () => fetchJson('/compare'),
  /** @returns {Promise<{timestamp:string, org:string, inventory:Object<string,string[]>, summary:{totalTypes:number,totalMembers:number}}|null>} */
  scan:                   () => fetchJson('/scan'),
  /** @returns {Promise<{timestamp:string, org:string, inventory:Object<string,string[]>, summary:{totalTypes:number,totalMembers:number}}>} */
  runScan:                (org) => postJson('/scan', { org }),
  /** @returns {Promise<{ version: string }>} */
  suggestVersion:         () => fetchJson('/release/suggest-version'),
  /** @returns {Promise<CompareResult>} */
  runCompare:             (source, target) => postJson('/compare', { source, target }),
  /** @returns {Promise<{ xml: string, filename?: string, path?: string, ok?: boolean }>} */
  buildManifest:          (items, opts = {}) => postJson('/compare/manifest', { items, ...opts }),
  /** @returns {Promise<{ sourceXml: string, targetXml: string }>} */
  compareDiff:            (type, member) => fetchJson(`/compare/diff?type=${encodeURIComponent(type)}&member=${encodeURIComponent(member)}`),
  /** @returns {Promise<{ manifests: Array<{relPath:string, filename:string, date:string}> }>} */
  listManifests:          () => fetchJson('/manifests'),
  /** @returns {Promise<{ xml: string, components: Array<{type:string, member:string}> }>} */
  getManifestContent:     (relPath) => fetchJson(`/manifests/content?path=${encodeURIComponent(relPath)}`),
  /** @returns {Promise<{ xml: string, addCount: number, delCount: number, filename: string, path: string, ok: boolean }>} */
  buildManifestFromGit:   (base, head, opts = {}) => postJson('/manifest/build', { base, head, ...opts }),
  /** @returns {Promise<AiAvailability>} */
  aiAvailable:            () => fetchJson('/ai/available'),
  /** @returns {Promise<{ history: DeployHistoryEntry[] }>} */
  deployHistory:          () => fetchJson('/deploy/history'),
  /** @returns {Promise<{ content: string, exists: boolean, file: string }>} */
  changelogContent:       (pkg) => fetchJson(`/changelog/content${pkg ? `?package=${encodeURIComponent(pkg)}` : ''}`),
  /** @returns {Promise<{ ok: boolean, file: string }>} */
  saveChangelog:          (content, pkg) => postJson('/changelog/save', { content, ...(pkg ? { package: pkg } : {}) }),
  /** @returns {Promise<{ ok: boolean, path: string }>} */
  saveReleaseNotes:       (content, opts = {}) => postJson('/release-notes/save', { content, ...opts }),
  /** @returns {Promise<{ tests: string[] }>} */
  detectTests:            (relPath) => fetchJson(`/manifest/detect-tests?path=${encodeURIComponent(relPath)}`),
  /** @returns {Promise<{ ok: boolean }>} */
  removeManifestComponent:(relPath, type, member) => postJson('/manifest/remove-component', { relPath, type, member }),
  addManifestComponent:   (relPath, type, member) => postJson('/manifest/add-component',    { relPath, type, member }),
  discoverComponents:     (type, exclude = []) => fetchJson(`/manifest/discover?type=${encodeURIComponent(type)}${exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : ''}`),
  /** @returns {Promise<{ prompts: Array<{key:string, label:string, description:string, feature:string, default:string, current:string, overridden:boolean}> }>} */
  listPrompts:            () => fetchJson('/prompts'),
  /** @returns {Promise<{ ok: boolean, key: string }>} */
  setPrompt:              (key, value) => patchJson(`/prompts/${encodeURIComponent(key)}`, { value }),
  /** @returns {Promise<{ ok: boolean, key: string }>} */
  resetPrompt:            (key) => deleteRequest(`/prompts/${encodeURIComponent(key)}`),
  /** @returns {Promise<object>} */
  getConfig:              () => fetchJson('/config'),
  /** @returns {Promise<{ ok: boolean, key: string, value: any }>} */
  setConfig:              (key, value) => patchJson('/config', { key, value: String(value) }),
  /** @returns {Promise<{ ok: boolean }>} */
  initProject:            (data) => postJson('/init', data),
  /** @returns {Promise<{ logs: object[] }>} */
  logs:                   (type = 'all') => fetchJson(`/logs${type !== 'all' ? `?type=${encodeURIComponent(type)}` : ''}`),
  /** @returns {Promise<{ nodes: Array<{id:string, name:string, type:string}>, edges: Array<{source:string, target:string}>, cachedAt: string, nodeCount: number, edgeCount: number }>} */
  dependencies:           (org, types) => fetchJson(`/dependencies?org=${encodeURIComponent(org)}${types ? `&types=${encodeURIComponent(types)}` : ''}`),
  /** @returns {Promise<{ status: 'pass'|'warn'|'fail', missing: Array<{name:string, type:string, referencedBy:string[]}>, warnings: Array<{name:string, type:string, referencedBy:string[]}> }>} */
  dependenciesPreflight:  (manifest, org) => fetchJson(`/dependencies/preflight?manifest=${encodeURIComponent(manifest)}&org=${encodeURIComponent(org)}`),
  /** @returns {Promise<Array<{key: string, description: string}>>} */
  pullGroups:             () => fetchJson('/pull/groups'),
  /** @returns {Promise<{ packages: Array<{name: string, path: string}> }>} */
  getPackages:            () => fetchJson('/packages'),
  /** @returns {Promise<{ files: string[] }>} */
  logsList:               () => fetchJson('/logs/list'),
  flowScan:               () => fetchJson('/flow/scan'),
  runFlowScan:            (org) => postJson('/flow/scan', { org }),
  flowConflicts:          () => fetchJson('/flow/conflicts'),
  runFlowConflicts:       (org) => postJson('/flow/conflicts', { org }),
  flowGraph:              () => fetchJson('/flow/graph'),
  runFlowGraph:           (org) => postJson('/flow/graph', { org }),
  auditLogs:              () => fetchJson('/audit/logs'),
};

// ─── SSE helpers ──────────────────────────────────────────────────────────────
// Returns an EventSource-like object with onmessage/onerror setters + close()

export function ssePost(path, body) {
  const url = `${BASE}${path}`;
  let controller = new AbortController();
  const handlers = { onmessage: null, onerror: null, ondone: null };

  (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: await jsonHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        // Surface the server's error body (e.g. 409 "An update is already in
        // progress") instead of a bare status line, so callers can show a
        // meaningful message rather than a generic "failed".
        let message = `${res.status} ${res.statusText}`;
        try {
          const data = await res.json();
          if (data?.error) message = data.error;
        } catch { /* non-JSON body — keep the status line */ }
        if (handlers.onerror) handlers.onerror(new Error(message));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const payload = JSON.parse(dataLine.slice(6));
            if (handlers.onmessage) handlers.onmessage({ data: payload });
          } catch { /* skip malformed */ }
        }
      }
      if (handlers.ondone) handlers.ondone();
    } catch (err) {
      if (err.name !== 'AbortError' && handlers.onerror) handlers.onerror(err);
    }
  })();

  return {
    set onmessage(fn) { handlers.onmessage = fn; },
    set onerror(fn) { handlers.onerror = fn; },
    set ondone(fn) { handlers.ondone = fn; },
    close() { controller.abort(); },
  };
}

export const stream = {
  deploy:           (opts) => ssePost('/release/deploy', opts),
  commandRun:       (command, extraParams = {}) => ssePost('/command/run', { command, ...extraParams }),
  pull:             (opts = {}) => ssePost('/pull', opts),
  update:           () => ssePost('/update/stream', {}),
  changelogGenerate:(pkg)  => ssePost('/changelog/generate', pkg ? { package: pkg } : {}),
  releaseNotes:     (opts = {}) => ssePost('/release-notes/generate', opts),
  review:           (base) => ssePost('/review', { base }),
  explain:          (logPath) => ssePost('/explain', logPath ? { logPath } : {}),
  qualityFixPlan:   () => ssePost('/quality/fix-plan', {}),
};

export function streamChatMessage(messages, pageContext, onChunk, onDone, onError) {
  const controller = new AbortController();

  (async () => {
    try {
      const res = await fetch(`${BASE}/ai/chat`, {
        method: 'POST',
        headers: await jsonHeaders(),
        body: JSON.stringify({ messages, pageContext }),
        signal: controller.signal,
      });

      if (!res.ok) {
        onError(`Request failed: ${res.status}`);
        return;
      }

      if (!res.body) {
        onError('No response body');
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let remainder = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        remainder += decoder.decode(value, { stream: true });
        const lines = remainder.split('\n');
        remainder = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            if (event.type === 'chunk') onChunk(event.text);
            else if (event.type === 'done') { onDone(); return; }
            else if (event.type === 'error') { onError(event.message); return; }
          } catch {
            // skip malformed lines
          }
        }
      }
      // Stream ended without explicit done event
      onDone();
    } catch (err) {
      if (err.name !== 'AbortError') onError(err.message);
    }
  })();

  return () => controller.abort();
}
