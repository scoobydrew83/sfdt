import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

const DEFAULT_THRESHOLD_BYTES = 50 * 1024; // 50 KB
const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24 hours

/**
 * Checks if a payload should be parked, and if so, writes it to the local cache.
 * Returns either the parked envelope descriptor or the original payload.
 *
 * @param {any} payload - The payload to check (string, object, or array)
 * @param {object} config - sfdt config
 * @returns {Promise<any>}
 */
export async function parkIfNeeded(payload, config) {
  const mcpConfig = config.mcp ?? {};
  const parkingConfig = mcpConfig.parking ?? {};
  
  const enabled = parkingConfig.enabled !== false;
  if (!enabled) return payload;

  const threshold = parkingConfig.thresholdBytes ?? DEFAULT_THRESHOLD_BYTES;
  
  let jsonString;
  let byteSize;
  
  if (typeof payload === 'string') {
    jsonString = payload;
    byteSize = Buffer.byteLength(payload, 'utf8');
  } else {
    jsonString = JSON.stringify(payload, null, 2);
    byteSize = Buffer.byteLength(jsonString, 'utf8');
  }

  // If size is below threshold, return original payload
  if (byteSize <= threshold) {
    return payload;
  }

  const uuid = crypto.randomUUID();
  const cacheDir = path.join(config._configDir, 'cache', 'parked');
  await fs.ensureDir(cacheDir);

  const filePath = path.join(cacheDir, `${uuid}.json`);
  await fs.writeFile(filePath, jsonString, 'utf8');

  // Generate a preview
  let preview = '';
  let rowCount = undefined;

  if (Array.isArray(payload)) {
    rowCount = payload.length;
    preview = JSON.stringify(payload.slice(0, 5), null, 2);
  } else if (payload && typeof payload === 'object') {
    const keys = Object.keys(payload);
    const slicedObj = {};
    for (const key of keys.slice(0, 5)) {
      slicedObj[key] = payload[key];
    }
    preview = JSON.stringify(slicedObj, null, 2);
  } else {
    preview = String(payload).slice(0, 500);
  }

  if (preview.length > 1000) {
    preview = preview.slice(0, 1000) + '\n... (truncated preview)';
  }

  const ttl = parkingConfig.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  return {
    _parked: true,
    ref: `parked://${uuid}`,
    byteSize,
    rowCount,
    preview,
    expiresAt,
  };
}

/**
 * Resolves a parked result reference.
 *
 * @param {string} ref - The parked:// reference string
 * @param {object} config - sfdt config
 * @returns {Promise<any>}
 */
export async function getParkedResult(ref, config) {
  if (!ref || !ref.startsWith('parked://')) {
    throw new Error(`Invalid parked result reference format: ${ref}`);
  }

  const uuid = ref.substring('parked://'.length);
  if (!/^[a-f0-9-]{36}$/i.test(uuid)) {
    throw new Error(`Invalid parked UUID format: ${uuid}`);
  }

  const filePath = path.join(config._configDir, 'cache', 'parked', `${uuid}.json`);
  if (!(await fs.pathExists(filePath))) {
    throw new Error(`Parked result not found or expired: ${ref}`);
  }

  const content = await fs.readFile(filePath, 'utf8');
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

/**
 * Cleans up expired parked results.
 *
 * @param {object} config - sfdt config
 * @returns {Promise<number>} - Number of cleaned up files
 */
export async function cleanupParkedResults(config) {
  const cacheDir = path.join(config._configDir, 'cache', 'parked');
  if (!(await fs.pathExists(cacheDir))) return 0;

  const mcpConfig = config.mcp ?? {};
  const parkingConfig = mcpConfig.parking ?? {};
  const ttl = parkingConfig.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const cutoff = Date.now() - ttl * 1000;

  const files = await fs.readdir(cacheDir);
  let cleanedCount = 0;

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(cacheDir, file);
    try {
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        await fs.remove(filePath);
        cleanedCount++;
      }
    } catch {
      // ignore errors
    }
  }

  return cleanedCount;
}
