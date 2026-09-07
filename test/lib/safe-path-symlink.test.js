import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

import {
  readFileInProject,
  readFileContained,
  writeFileContained,
  resolveInProject,
} from '../../src/lib/safe-path.js';

// Real files, real symlinks, no mocks. A mocked fs cannot tell you whether readFile follows a
// link — which is exactly the property that made lexical containment insufficient here.

let tmp;
let project;
let secretPath;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-safe-path-'));
  project = path.join(tmp, 'project');
  await fs.ensureDir(path.join(project, 'logs'));

  // Stands in for ~/.sfdx/<user>.json or ~/.aws/credentials — outside the project.
  secretPath = path.join(tmp, 'secrets.json');
  // A canary, deliberately NOT shaped like a real credential. The test only needs a string it
  // can prove never came back; giving it a Salesforce session-id shape adds nothing and trips
  // secret scanners on every commit.
  await fs.writeJson(secretPath, { note: 'CANARY-MUST-NOT-BE-READ' });

  await fs.writeFile(path.join(project, 'logs', 'real.log'), 'ordinary log content\n');
});

afterAll(async () => {
  await fs.remove(tmp);
});

describe('readFileInProject / readFileContained', () => {
  it('reads an ordinary in-project file', async () => {
    await expect(readFileInProject(project, 'logs/real.log')).resolves.toContain('ordinary log');
  });

  it('refuses an absolute path', async () => {
    await expect(readFileInProject(project, secretPath)).rejects.toThrow(/absolute paths/);
  });

  it('refuses a traversing path', async () => {
    await expect(readFileInProject(project, '../secrets.json')).rejects.toThrow(/segments are not allowed|outside the project/);
  });

  // The actual M-1 primitive: a symlink planted INSIDE the project, whose lexical path is
  // impeccably contained, pointing at a file outside it. resolveInProject alone accepts this.
  it('refuses a symlinked leaf pointing outside the project', async () => {
    const link = path.join(project, 'logs', 'deploy.log');
    await fs.remove(link);
    await fs.symlink(secretPath, link);

    // The lexical guard is happy — which is precisely the gap.
    expect(resolveInProject(project, 'logs/deploy.log')).toBe(link);

    await expect(readFileInProject(project, 'logs/deploy.log')).rejects.toThrow(
      /symlinks are not allowed|outside the project/,
    );
  });

  it('refuses a symlinked leaf via the already-resolved entry point too', async () => {
    const link = path.join(project, 'logs', 'deploy.log');
    await expect(readFileContained(project, link, { label: 'log' })).rejects.toThrow(
      /symlinks are not allowed|outside the project/,
    );
  });

  // O_NOFOLLOW only refuses a symlinked LEAF; a symlinked parent directory opens normally.
  // The realpath containment re-check is what covers this one.
  it('refuses a file reached through a symlinked parent directory', async () => {
    const outsideDir = path.join(tmp, 'outside');
    await fs.ensureDir(outsideDir);
    await fs.writeFile(path.join(outsideDir, 'note.txt'), 'outside content\n');
    await fs.symlink(outsideDir, path.join(project, 'linkdir'));

    await expect(readFileInProject(project, 'linkdir/note.txt')).rejects.toThrow(/outside the project/);
  });

  // Writes need the same guard: lexical containment stops `../` but not a symlink, and a
  // committed `changelogs/pkg.md -> ~/.zshrc` arrives with the clone.
  describe('writeFileContained', () => {
    it('writes an ordinary in-project file', async () => {
      await writeFileContained(project, path.join(project, 'notes.md'), 'hello\n');
      await expect(fs.readFile(path.join(project, 'notes.md'), 'utf8')).resolves.toBe('hello\n');
    });

    it('refuses to write through a symlink pointing outside the project', async () => {
      const target = path.join(tmp, 'victim-rc');
      await fs.writeFile(target, 'ORIGINAL\n');
      const link = path.join(project, 'hijack.md');
      await fs.remove(link);
      await fs.symlink(target, link);

      await expect(writeFileContained(project, link, 'PWNED\n')).rejects.toThrow(
        /symlinks are not allowed|outside the project/,
      );
      // The point of the test: the target must be untouched.
      await expect(fs.readFile(target, 'utf8')).resolves.toBe('ORIGINAL\n');
    });

    it('refuses a write whose parent directory is a symlink out of the project', async () => {
      await expect(
        writeFileContained(project, path.join(project, 'linkdir', 'new.txt'), 'x'),
      ).rejects.toThrow(/outside the project/);
    });
  });

  // Several roots: the manifest-viewer route allows a file under manifestDir OR logDir. That
  // rule is why the route kept a hand-written copy of this guard; the helper takes an array so
  // there is one implementation again.
  describe('multiple roots', () => {
    it('accepts a file under either root', async () => {
      const other = path.join(tmp, 'second-root');
      await fs.ensureDir(other);
      await fs.writeFile(path.join(other, 'ok.xml'), '<x/>\n');

      await expect(readFileContained([project, other], path.join(other, 'ok.xml'))).resolves.toContain('<x/>');
      await expect(readFileContained([project, other], path.join(project, 'logs', 'real.log'))).resolves.toContain('ordinary log');
    });

    it('still refuses a path under neither', async () => {
      const other = path.join(tmp, 'second-root');
      await expect(readFileContained([project, other], secretPath)).rejects.toThrow(/outside the project/);
    });
  });

  // A missing file and an escaping one are both refusals, but callers map them to 404 and 403.
  // Reporting "resolves outside the project" for a mistyped filename sent operators hunting a
  // security problem that was not there.
  it('reports a missing file as ENOENT, not as a containment failure', async () => {
    await expect(readFileInProject(project, 'logs/nope.log')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('does not leak the secret through any of the above', async () => {
    for (const attempt of ['logs/deploy.log', 'linkdir/note.txt']) {
      const result = await readFileInProject(project, attempt).catch((err) => err.message);
      expect(result).not.toContain('CANARY-MUST-NOT-BE-READ');
    }
  });
});
