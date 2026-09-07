import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';

import { findProjectRoot, loadConfig } from '../../src/lib/config.js';

// Deliberately NOT mocked. Every other containment test mocks loadConfig, which is exactly
// how the fail-open in sfdt-private#23 survived review: mocking "loadConfig threw" encodes
// the assumption that a throw means "no project here", and that assumption is the bug. These
// tests run against a real directory tree so the two cases can actually differ.

let tmp;
let project;

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-find-root-'));
  project = path.join(tmp, 'customer-a');
  await fs.ensureDir(path.join(project, '.sfdt'));
  await fs.ensureDir(path.join(project, 'force-app', 'main', 'default'));
  await fs.writeJson(path.join(project, 'sfdx-project.json'), {
    packageDirectories: [{ path: 'force-app', default: true }],
  });
});

afterAll(async () => {
  await fs.remove(tmp);
});

describe('findProjectRoot', () => {
  it('finds the project root from the root itself', () => {
    expect(findProjectRoot(project)).toBe(project);
  });

  it('walks up from a nested subdirectory', () => {
    expect(findProjectRoot(path.join(project, 'force-app', 'main', 'default'))).toBe(project);
  });

  it('returns null outside any project', async () => {
    const outside = path.join(tmp, 'not-a-project');
    await fs.ensureDir(outside);
    expect(findProjectRoot(outside)).toBeNull();
  });

  // The three triggers that could flip a project-bound MCP server to unrestricted. Each is a
  // COMMITTED file, so a cloned repo controls it. loadConfig must still fail — that part is
  // correct — but discovery must keep saying "you are inside a project."
  describe('a broken committed file does not make a project stop being a project', () => {
    it('malformed sfdx-project.json: loadConfig fails, discovery still finds the root', async () => {
      const broken = path.join(tmp, 'broken-sfdx');
      await fs.ensureDir(path.join(broken, '.sfdt'));
      await fs.writeJson(path.join(broken, '.sfdt', 'config.json'), {
        defaultOrg: 'dev', features: {},
      });
      await fs.writeFile(path.join(broken, 'sfdx-project.json'), '{ "packageDirectories": [ }');

      await expect(loadConfig(broken)).rejects.toThrow(/Failed to parse .*sfdx-project\.json/);
      expect(findProjectRoot(broken)).toBe(broken);
    });

    it('schema-invalid .sfdt/config.json: loadConfig fails, discovery still finds the root', async () => {
      const broken = path.join(tmp, 'broken-schema');
      await fs.ensureDir(path.join(broken, '.sfdt'));
      await fs.writeJson(path.join(broken, 'sfdx-project.json'), { packageDirectories: [] });
      // Parses as JSON, fails validation — defaultOrg has minLength 1.
      await fs.writeJson(path.join(broken, '.sfdt', 'config.json'), { defaultOrg: '', features: {} });

      await expect(loadConfig(broken)).rejects.toThrow();
      expect(findProjectRoot(broken)).toBe(broken);
    });

    it('unparseable .sfdt/config.json: loadConfig fails, discovery still finds the root', async () => {
      const broken = path.join(tmp, 'broken-json');
      await fs.ensureDir(path.join(broken, '.sfdt'));
      await fs.writeJson(path.join(broken, 'sfdx-project.json'), { packageDirectories: [] });
      await fs.writeFile(path.join(broken, '.sfdt', 'config.json'), '{ not json');

      await expect(loadConfig(broken)).rejects.toThrow(/Failed to parse/);
      expect(findProjectRoot(broken)).toBe(broken);
    });

    it('missing .sfdt/ entirely: loadConfig fails, discovery still finds the root', async () => {
      const bare = path.join(tmp, 'no-sfdt-dir');
      await fs.ensureDir(bare);
      await fs.writeJson(path.join(bare, 'sfdx-project.json'), { packageDirectories: [] });

      await expect(loadConfig(bare)).rejects.toThrow();
      expect(findProjectRoot(bare)).toBe(bare);
    });
  });
});
