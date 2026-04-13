const BASE = '/api';

async function fetchJson(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  project: () => fetchJson('/project'),
  testRuns: () => fetchJson('/test-runs'),
  preflight: () => fetchJson('/preflight'),
  drift: () => fetchJson('/drift'),
  health: () => fetchJson('/health'),
};
