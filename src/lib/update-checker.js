const NPM_REGISTRY_URL = 'https://registry.npmjs.org/@sfdt/cli/latest';

export async function fetchLatestVersion() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(NPM_REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`npm registry responded with ${res.status}`);
    const data = await res.json();
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}
