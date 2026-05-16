const BASE = '/api';
function httpError(res) {
  const err = new Error(`${res.status} ${res.statusText}`);
  err.status = res.status;
  return err;
}
let csrfTokenPromise = null;
async function getCsrfToken() {
  if (!csrfTokenPromise) {
    csrfTokenPromise = fetch(`${BASE}/csrf-token`)
      .then((res) => {
        if (!res.ok) throw httpError(res);
        return res.json();
      })
      .then((data) => data.token);
  }
  return csrfTokenPromise;
}
async function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'X-SFDT-CSRF': await getCsrfToken(),
  };
}
async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw httpError(res);
  return res.json();
}
async function deleteJson(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: await jsonHeaders(),
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}
async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}
async function patchJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    headers: await jsonHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}
async function deleteRequest(path) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
    headers: { 'X-SFDT-CSRF': await getCsrfToken() },
  });
  if (!res.ok) throw httpError(res);
  return res.json();
}
export const api = {
  project:                () => fetchJson('/project'),
  checkUpdates:           () => fetchJson('/check-updates'),
  testRuns:               () => fetchJson('/test-runs'),
  deleteTestRun:          (filename) => deleteJson(`/test-runs/${encodeURIComponent(filename)}`),
  testClasses:            () => fetchJson('/test/classes'),
  syncTestClasses:        () => postJson('/test/classes/sync', {}),
  preflight:              () => fetchJson('/preflight'),
  drift:                  () => fetchJson('/drift'),
  quality:                () => fetchJson('/quality'),
  health:                 () => fetchJson('/health'),
  orgs:                   () => fetchJson('/orgs'),
  sessionOrg:             () => fetchJson('/session/org'),
  setSessionOrg:          (org) => postJson('/session/org', { org }),
  compareResult:          () => fetchJson('/compare'),
  scan:                   () => fetchJson('/scan'),
  runScan:                (org) => postJson('/scan', { org }),
  suggestVersion:         () => fetchJson('/release/suggest-version'),
  runCompare:             (source, target) => postJson('/compare', { source, target }),
  buildManifest:          (items, opts = {}) => postJson('/compare/manifest', { items, ...opts }),
  compareDiff:            (type, member) => fetchJson(`/compare/diff?type=${encodeURIComponent(type)}&member=${encodeURIComponent(member)}`),
  listManifests:          () => fetchJson('/manifests'),
  getManifestContent:     (relPath) => fetchJson(`/manifests/content?path=${encodeURIComponent(relPath)}`),
  buildManifestFromGit:   (base, head, opts = {}) => postJson('/manifest/build', { base, head, ...opts }),
  aiAvailable:            () => fetchJson('/ai/available'),
  deployHistory:          () => fetchJson('/deploy/history'),
  changelogContent:       (pkg) => fetchJson(`/changelog/content${pkg ? `?package=${encodeURIComponent(pkg)}` : ''}`),
  saveChangelog:          (content, pkg) => postJson('/changelog/save', { content, ...(pkg ? { package: pkg } : {}) }),
  saveReleaseNotes:       (content, opts = {}) => postJson('/release-notes/save', { content, ...opts }),
  detectTests:            (relPath) => fetchJson(`/manifest/detect-tests?path=${encodeURIComponent(relPath)}`),
  removeManifestComponent:(relPath, type, member) => postJson('/manifest/remove-component', { relPath, type, member }),
  addManifestComponent:   (relPath, type, member) => postJson('/manifest/add-component',    { relPath, type, member }),
  discoverComponents:     (type, exclude = []) => fetchJson(`/manifest/discover?type=${encodeURIComponent(type)}${exclude.length ? `&exclude=${encodeURIComponent(exclude.join(','))}` : ''}`),
  listPrompts:            () => fetchJson('/prompts'),
  setPrompt:              (key, value) => patchJson(`/prompts/${encodeURIComponent(key)}`, { value }),
  resetPrompt:            (key) => deleteRequest(`/prompts/${encodeURIComponent(key)}`),
  getConfig:              () => fetchJson('/config'),
  setConfig:              (key, value) => patchJson('/config', { key, value: String(value) }),
  initProject:            (data) => postJson('/init', data),
  logs:                   (type = 'all') => fetchJson(`/logs${type !== 'all' ? `?type=${encodeURIComponent(type)}` : ''}`),
  dependencies:           (org, types) => fetchJson(`/dependencies?org=${encodeURIComponent(org)}${types ? `&types=${encodeURIComponent(types)}` : ''}`),
  dependenciesPreflight:  (manifest, org) => fetchJson(`/dependencies/preflight?manifest=${encodeURIComponent(manifest)}&org=${encodeURIComponent(org)}`),
  pullGroups:             () => fetchJson('/pull/groups'),
  getPackages:            () => fetchJson('/packages'),
  logsList:               () => fetchJson('/logs/list'),
};
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
          } catch {  }
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
          }
        }
      }
      onDone();
    } catch (err) {
      if (err.name !== 'AbortError') onError(err.message);
    }
  })();
  return () => controller.abort();
}
