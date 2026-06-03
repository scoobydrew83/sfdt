const NPM_REGISTRY_BASE = 'https://registry.npmjs.org';

export async function fetchLatestVersion(pkg = '@sfdt/cli') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${NPM_REGISTRY_BASE}/${pkg}/latest`, { signal: controller.signal });
    if (!res.ok) throw new Error(`npm registry responded with ${res.status}`);
    const data = await res.json();
    return data.version;
  } finally {
    clearTimeout(timeout);
  }
}
