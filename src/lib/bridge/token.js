import crypto from 'crypto';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
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
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
  }
  _cached = token;
  return token;
}
export function clearBridgeTokenCache() {
  _cached = null;
}
export async function rotateBridgeToken() {
  const dir = tokenDir();
  const file = tokenPath();
  await fs.ensureDir(dir);
  const token = crypto.randomBytes(32).toString('base64url');
  await fs.writeFile(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.chmod(file, 0o600);
  } catch {
  }
  _cached = token;
  return token;
}
export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
