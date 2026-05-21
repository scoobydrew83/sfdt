/**
 * Bridge token storage.
 *
 * The bridge token is a USER-global secret (not per-project) that the Chrome
 * extension presents as a Bearer token on every /api/bridge/* request and on
 * every native messaging call. It is created lazily on first read, kept in
 * `~/.sfdt/bridge-token`, and chmodded 0600 so other users on the machine
 * cannot read it.
 *
 * Why not the CSRF token? CSRF protects same-origin attacks via cookies. The
 * bridge has no cookies — it accepts cross-origin requests from
 * `*.salesforce.com` and `chrome-extension://*` origins. A bearer token gives
 * us a stable, copyable secret that the user can paste into the extension's
 * options page once.
 */

import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

// Resolve the path lazily so tests that mock `os.homedir()` see the mocked
// value. (Resolving at module load freezes whichever homedir was active when
// token.js was first imported, which defeats the mock.)
function tokenDir() {
  return path.join(os.homedir(), '.sfdt');
}

function tokenPath() {
  return path.join(tokenDir(), 'bridge-token');
}

let _cached = null;

export function getBridgeTokenPath() {
  return tokenPath();
}

/**
 * Read the bridge token from disk, creating it if it does not exist.
 * Returns the token string (~43 base64url characters, 32 bytes of entropy).
 *
 * Subsequent reads in the same process are served from an in-memory cache;
 * call `clearBridgeTokenCache()` to force a re-read (mostly for tests).
 */
export async function getOrCreateBridgeToken() {
  if (_cached) return _cached;

  const dir = tokenDir();
  const file = tokenPath();
  await fs.ensureDir(dir);

  if (await fs.pathExists(file)) {
    const raw = await fs.readFile(file, 'utf8');
    const token = raw.trim();
    if (token.length >= 16) {
      _cached = token;
      return token;
    }
    // File exists but looks empty or truncated — rotate it.
  }

  const token = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // Non-POSIX filesystems (e.g. some Windows setups) ignore chmod silently.
  }
  _cached = token;
  return token;
}

/**
 * Force a re-read on the next getOrCreateBridgeToken() call.
 */
export function clearBridgeTokenCache() {
  _cached = null;
}

/**
 * Rotate the bridge token to a fresh random value. After this call, any
 * previously paired extension instance must be re-paired.
 */
export async function rotateBridgeToken() {
  const dir = tokenDir();
  const file = tokenPath();
  await fs.ensureDir(dir);
  const token = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
    // see above
  }
  _cached = token;
  return token;
}

/**
 * Constant-time comparison so token validation does not leak bytes — or the
 * expected token length — via timing. timingSafeEqual requires equal-length
 * buffers, and a bare length pre-check would leak which length the server
 * expects. Pad both sides to the same length first; equal-length AND
 * timingSafeEqual must both hold for the token to be accepted.
 */
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // Pad both sides to a common length so timingSafeEqual can run regardless
  // of input length. The bare length pre-check (`if (ba.length !== bb.length)
  // return false`) was the canonical timing-leak pattern — observing how
  // quickly we reject a candidate reveals the expected length. Padding to a
  // minimum of 1 byte keeps the empty-string == empty-string edge case
  // working without skipping the constant-time call.
  const maxLen = Math.max(ba.length, bb.length, 1);
  const paddedA = Buffer.concat([ba, Buffer.alloc(maxLen - ba.length)], maxLen);
  const paddedB = Buffer.concat([bb, Buffer.alloc(maxLen - bb.length)], maxLen);
  const eq = crypto.timingSafeEqual(paddedA, paddedB);
  return eq && ba.length === bb.length;
}
