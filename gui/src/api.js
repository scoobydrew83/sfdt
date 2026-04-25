const BASE = '/api';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  project:                () => fetchJson('/project'),
  checkUpdates:           () => fetchJson('/check-updates'),
  testRuns:               () => fetchJson('/test-runs'),
  preflight:              () => fetchJson('/preflight'),
  drift:                  () => fetchJson('/drift'),
  health:                 () => fetchJson('/health'),
  orgs:                   () => fetchJson('/orgs'),
  compareResult:          () => fetchJson('/compare'),
  runCompare:             (source, target) => postJson('/compare', { source, target }),
  buildManifest:          (items, apiVersion) => postJson('/compare/manifest', { items, apiVersion }),
  compareDiff:            (type, member) => fetchJson(`/compare/diff?type=${encodeURIComponent(type)}&member=${encodeURIComponent(member)}`),
  listManifests:          () => fetchJson('/manifests'),
  getManifestContent:     (relPath) => fetchJson(`/manifests/content?path=${encodeURIComponent(relPath)}`),
  buildManifestFromGit:   (base, head) => postJson('/manifest/build', { base, head }),
  aiAvailable:            () => fetchJson('/ai/available'),
  deployHistory:          () => fetchJson('/deploy/history'),
  changelogContent:       () => fetchJson('/changelog/content'),
  removeManifestComponent:(relPath, type, member) => postJson('/manifest/remove-component', { relPath, type, member }),
};

// SSE helpers — return an EventSource-like object with onmessage/onerror + close()
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
