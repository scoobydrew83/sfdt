import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs-extra';
import os from 'os';
import { detectLwcTests, buildLwcTestArgs } from '../../src/lib/lwc-test.js';

let root;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-lwc-'));
});

afterEach(async () => {
  await fs.remove(root);
});

async function scaffold({ pkg, withTests } = {}) {
  if (pkg) await fs.writeJson(path.join(root, 'package.json'), pkg);
  if (withTests) {
    await fs.ensureDir(path.join(root, 'force-app', 'main', 'default', 'lwc', 'hello', '__tests__'));
  }
}

describe('detectLwcTests', () => {
  it('detects the npm test:unit script runner', async () => {
    await scaffold({ pkg: { scripts: { 'test:unit': 'sfdx-lwc-jest' } }, withTests: true });
    const r = await detectLwcTests(root, ['force-app']);
    expect(r).toMatchObject({ detected: true, runner: 'script' });
  });

  it('detects the sfdx-lwc-jest dependency runner without a script', async () => {
    await scaffold({ pkg: { devDependencies: { '@salesforce/sfdx-lwc-jest': '^7.0.0' } }, withTests: true });
    const r = await detectLwcTests(root, ['force-app']);
    expect(r).toMatchObject({ detected: true, runner: 'jest' });
  });

  it('accepts the legacy sfdx-lwc-jest package name', async () => {
    await scaffold({ pkg: { devDependencies: { 'sfdx-lwc-jest': '^1.0.0' } }, withTests: true });
    const r = await detectLwcTests(root, ['force-app']);
    expect(r.detected).toBe(true);
  });

  it('is not detected without a Jest runner in package.json', async () => {
    await scaffold({ pkg: { devDependencies: { vitest: '1.0.0' } }, withTests: true });
    const r = await detectLwcTests(root, ['force-app']);
    expect(r.detected).toBe(false);
    expect(r.reason).toContain('sfdx-lwc-jest');
  });

  it('is not detected without any lwc __tests__ directories', async () => {
    await scaffold({ pkg: { scripts: { 'test:unit': 'sfdx-lwc-jest' } } });
    const r = await detectLwcTests(root, ['force-app']);
    expect(r.detected).toBe(false);
    expect(r.reason).toContain('__tests__');
  });

  it('is not detected without a package.json (never throws)', async () => {
    const r = await detectLwcTests(root, ['force-app']);
    expect(r.detected).toBe(false);
    expect(r.reason).toContain('package.json');
  });

  it('honours packageDirectories objects with a path property', async () => {
    await scaffold({ pkg: { scripts: { 'test:unit': 'jest' } } });
    await fs.ensureDir(path.join(root, 'src-pkg', 'lwc', 'cmp', '__tests__'));
    const r = await detectLwcTests(root, [{ path: 'src-pkg' }]);
    expect(r.detected).toBe(true);
  });
});

describe('buildLwcTestArgs', () => {
  it('uses the npm script when wired', () => {
    expect(buildLwcTestArgs('script')).toEqual({ command: 'npm', args: ['run', 'test:unit'] });
  });

  it('falls back to the sfdx-lwc-jest binary', () => {
    expect(buildLwcTestArgs('jest')).toEqual({ command: 'npx', args: ['sfdx-lwc-jest'] });
  });
});
