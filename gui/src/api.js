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
 * @typedef {{ available: boolean, enabled: boolean, provider: string }} AiAvailability
 * @typedef {{ date: string, manifest: string, org: string, dryRun: boolean, skipPreflight: boolean, exitCode: number }} DeployHistoryEntry
 */

function httpError(res) {
  const err = new Error(`${res.status} ${res.statusText}`);
  err.status = res.status;
  return err;
}

/** @returns {Promise<any>} */
async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw httpError(res);
  return res.json();
}

/** @returns {Promise<any>} */
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}

/** @returns {Promise<any>} */
async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}

export const api = {
  /** @returns {Promise<ProjectInfo>} */
  project:                () => fetchJson('/project'),
  /** @returns {Promise<UpdateInfo>} */
  checkUpdates:           () => fetchJson('/check-updates'),
  /** @returns {Promise<{ runs: TestRun[] }>} */
  testRuns:               () => fetchJson('/test-runs'),
  /** @returns {Promise<PreflightResult>} */
  preflight:              () => fetchJson('/preflight'),
  /** @returns {Promise<DriftResult>} */
  drift:                  () => fetchJson('/drift'),
  /** @returns {Promise<{ ok: boolean }>} */
  health:                 () => fetchJson('/health'),
  /** @returns {Promise<{ orgs: OrgEntry[] }>} */
  orgs:                   () => fetchJson('/orgs'),
  /** @returns {Promise<CompareResult>} */
  compareResult:          () => fetchJson('/compare'),
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
  /** @returns {Promise<{ content: string, exists: boolean }>} */
  changelogContent:       () => fetchJson('/changelog/content'),
  /** @returns {Promise<{ ok: boolean }>} */
  saveChangelog:          (content) => postJson('/changelog/save', { content }),
  /** @returns {Promise<{ ok: boolean, path: string }>} */
  saveReleaseNotes:       (content) => postJson('/release-notes/save', { content }),
  /** @returns {Promise<{ tests: string[] }>} */
  detectTests:            (relPath) => fetchJson(`/manifest/detect-tests?path=${encodeURIComponent(relPath)}`),
  /** @returns {Promise<{ ok: boolean }>} */
  removeManifestComponent:(relPath, type, member) => postJson('/manifest/remove-component', { relPath, type, member }),
  /** @returns {Promise<object>} */
  getConfig:              () => fetchJson('/config'),
  /** @returns {Promise<{ ok: boolean, key: string, value: any }>} */
  setConfig:              (key, value) => patchJson('/config', { key, value: String(value) }),
  /** @returns {Promise<{ ok: boolean }>} */
  initProject:            (data) => postJson('/init', data),
  /** @returns {Promise<{ logs: object[] }>} */
  logs:                   (type = 'all') => fetchJson(`/logs${type !== 'all' ? `?type=${encodeURIComponent(type)}` : ''}`),
};

// ─── SSE helpers ──────────────────────────────────────────────────────────────
// Returns an EventSource-like object with onmessage/onerror setters + close()

function ssePost(path, body) {
  const url = `${BASE}${path}`;
  let controller = new AbortController();
  const handlers = { onmessage: null, onerror: null, ondone: null };

  (async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        if (handlers.onerror) handlers.onerror(new Error(`${res.status} ${res.statusText}`));
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
  changelogGenerate:()     => ssePost('/changelog/generate', {}),
  releaseNotes:     ()     => ssePost('/release-notes/generate', {}),
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
        headers: { 'Content-Type': 'application/json' },
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
