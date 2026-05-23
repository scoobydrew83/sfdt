import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Read <projectRoot>/.sfdt/feature-flags.json and return the `disabled`
 * array, filtering to non-empty strings. Tolerant: a missing file, malformed
 * JSON, or wrong-shape contents all return [] (with an optional warning via
 * opts.onWarn).
 *
 * @param {string} projectRoot
 * @param {{ onWarn?: (msg: string) => void }} [opts]
 * @returns {Promise<string[]>}
 */
export async function readDisabledFeatures(projectRoot, opts = {}) {
  const warn = opts.onWarn ?? ((msg) => console.warn(`[sfdt bridge] ${msg}`));
  const path = join(projectRoot, '.sfdt', 'feature-flags.json');
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    warn(`Could not read feature-flags.json: ${err.message}`);
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(`feature-flags.json contains invalid JSON: ${err.message}`);
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.disabled)) {
    return [];
  }
  return parsed.disabled.filter((v) => typeof v === 'string' && v.length > 0);
}
