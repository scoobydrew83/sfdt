import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

import { readLocalComponentXml } from '../../src/lib/gui-server/handlers.js';

// Real files, real symlinks, no mocks — a mocked fs cannot tell you whether readFile
// follows a link, which is the whole property under test. Mirrors the setup in
// safe-path-symlink.test.js.
//
// Regression guard for the pre-v0.26.1 gate finding: readLocalComponentXml globbed the
// source tree and read the hit with a bare fs-extra readFile. The `..` filter it relied
// on is a *string* check on the glob hit's own path, so a symlink placed inside
// force-app/ passed it and the read followed the link off disk. A developer who cloned
// a hostile SFDX repo and opened the Compare page leaked the target into the browser.

let tmp;
let project;
let secretPath;
const sourcePath = 'force-app/main/default';

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-component-symlink-'));
  project = path.join(tmp, 'project');
  await fs.ensureDir(path.join(project, sourcePath, 'classes'));

  // Stands in for ~/.sfdx/<user>.json. A canary, deliberately not credential-shaped.
  secretPath = path.join(tmp, 'outside.json');
  await fs.writeFile(secretPath, 'CANARY-MUST-NOT-BE-READ\n');

  await fs.writeFile(
    path.join(project, sourcePath, 'classes', 'RealClass.cls'),
    'public class RealClass {}\n'
  );

  // The attack: a .cls inside the source tree that is really a link outside it.
  await fs.symlink(
    secretPath,
    path.join(project, sourcePath, 'classes', 'EscapingClass.cls')
  );
});

afterAll(async () => {
  await fs.remove(tmp);
});

const config = () => ({ _projectRoot: project, defaultSourcePath: sourcePath });

describe('readLocalComponentXml containment', () => {
  it('reads an ordinary in-tree component', async () => {
    const xml = await readLocalComponentXml(config(), 'ApexClass', 'RealClass');
    expect(xml).toBe('public class RealClass {}\n');
  });

  it('refuses a symlink that escapes the source tree', async () => {
    const xml = await readLocalComponentXml(config(), 'ApexClass', 'EscapingClass');
    expect(xml).toBeNull();
  });

  it('never returns the symlink target contents', async () => {
    const xml = await readLocalComponentXml(config(), 'ApexClass', 'EscapingClass');
    expect(xml ?? '').not.toContain('CANARY-MUST-NOT-BE-READ');
  });

  it('still rejects traversal in the member parameter itself', async () => {
    expect(await readLocalComponentXml(config(), 'ApexClass', '../outside')).toBeNull();
    expect(await readLocalComponentXml(config(), 'ApexClass', 'a/b')).toBeNull();
  });
});
