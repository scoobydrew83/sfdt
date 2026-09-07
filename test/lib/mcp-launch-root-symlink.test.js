import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

import { loadConfig } from '../../src/lib/config.js';
import { realpathOrSelf } from '../../src/lib/safe-path.js';

// Real directories, a real symlink, no mocks. The mcp-server suite mocks loadConfig, so it
// cannot see this class of bug at all: the bypass lives in the gap between a LEXICAL
// containment check and a filesystem that follows links. Only real paths expose it.

let tmp;
let hostile;
let victim;

beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-launchroot-')));

  hostile = path.join(tmp, 'hostile');
  await fs.ensureDir(path.join(hostile, '.sfdt'));
  await fs.writeJson(path.join(hostile, 'sfdx-project.json'), { packageDirectories: [] });
  await fs.writeJson(path.join(hostile, '.sfdt', 'config.json'), {
    defaultOrg: 'HOSTILE', features: {},
  });

  victim = path.join(tmp, 'victim');
  await fs.ensureDir(path.join(victim, '.sfdt'));
  await fs.writeJson(path.join(victim, 'sfdx-project.json'), { packageDirectories: [] });
  await fs.writeJson(path.join(victim, '.sfdt', 'config.json'), {
    defaultOrg: 'VICTIM-PROD-ORG', features: {},
  });

  // The committed symlink. git stores these faithfully, so it arrives with the clone.
  await fs.symlink('/', path.join(hostile, 'escape'));
});

afterAll(async () => {
  await fs.remove(tmp);
});

// Mirrors the containment check in SfdtMcpServer#assertRootAllowed. Kept in step with it
// deliberately: the point is to prove the PHYSICAL comparison rejects what the lexical one
// accepted, which needs the real filesystem the server itself will hit.
async function contains(launchRoot, requested) {
  const root = await realpathOrSelf(path.resolve(launchRoot));
  const resolved = await realpathOrSelf(path.resolve(requested));
  return resolved === root || resolved.startsWith(root + path.sep);
}

describe('launch-root containment against a committed symlink', () => {
  it('the lexical check alone accepts an escaping path — this is the bug', () => {
    const evil = path.join(hostile, 'escape', victim.replace(/^\//, ''));
    const resolved = path.resolve(evil);
    expect(resolved.startsWith(hostile + path.sep)).toBe(true);
  });

  it('and that path really does serve the OTHER project', async () => {
    const evil = path.join(hostile, 'escape', victim.replace(/^\//, ''));
    const cfg = await loadConfig(evil);
    expect(cfg.defaultOrg).toBe('VICTIM-PROD-ORG');
  });

  it('the physical check refuses it', async () => {
    const evil = path.join(hostile, 'escape', victim.replace(/^\//, ''));
    await expect(contains(hostile, evil)).resolves.toBe(false);
  });

  it('still accepts the launch root itself', async () => {
    await expect(contains(hostile, hostile)).resolves.toBe(true);
  });

  it('still accepts a genuine subdirectory', async () => {
    const sub = path.join(hostile, 'force-app', 'main');
    await fs.ensureDir(sub);
    await expect(contains(hostile, sub)).resolves.toBe(true);
  });

  it('still refuses a sibling sharing the prefix', async () => {
    const sibling = `${hostile}-evil`;
    await fs.ensureDir(sibling);
    await expect(contains(hostile, sibling)).resolves.toBe(false);
  });

  it('refuses a symlinked subdirectory pointing at the other project', async () => {
    const link = path.join(hostile, 'linked-sub');
    await fs.remove(link);
    await fs.symlink(victim, link);
    await expect(contains(hostile, link)).resolves.toBe(false);
  });
});
