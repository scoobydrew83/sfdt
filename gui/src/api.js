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
  project:              () => fetchJson('/project'),
  checkUpdates:         () => fetchJson('/check-updates'),
  testRuns:             () => fetchJson('/test-runs'),
  preflight:            () => fetchJson('/preflight'),
  drift:                () => fetchJson('/drift'),
  health:               () => fetchJson('/health'),
  orgs:                 () => fetchJson('/orgs'),
  compareResult:        () => fetchJson('/compare'),
  runCompare:           (source, target) => postJson('/compare', { source, target }),
  buildManifest:        (items, apiVersion) => postJson('/compare/manifest', { items, apiVersion }),
  compareDiff:          (type, member) => fetchJson(`/compare/diff?type=${encodeURIComponent(type)}&member=${encodeURIComponent(member)}`),
  listManifests:        () => fetchJson('/manifests'),
  getManifestContent:   (relPath) => fetchJson(`/manifests/content?path=${encodeURIComponent(relPath)}`),
  buildManifestFromGit: (base, head) => postJson('/manifest/build', { base, head }),
  aiAvailable:          () => fetchJson('/ai/available'),
};
