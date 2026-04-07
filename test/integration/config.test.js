import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { loadConfig } from '../../src/lib/config.js';

const FIXTURES_DIR = new URL('../fixtures', import.meta.url).pathname;

function readFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

describe('loadConfig integration', () => {
  let tempDir;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sfdt-test-'));

    // Write sfdx-project.json at the project root
    await writeFile(join(tempDir, 'sfdx-project.json'), readFixture('sfdx-project.json'));

    // Create .sfdt/ directory
    const sfdtDir = join(tempDir, '.sfdt');
    await mkdir(sfdtDir);

    // Write config.json
    await writeFile(join(sfdtDir, 'config.json'), readFixture('sfdt-config.json'));

    // Write test-config.json
    await writeFile(join(sfdtDir, 'test-config.json'), readFixture('sfdt-test-config.json'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it('enriches sourceApiVersion from sfdx-project.json', async () => {
    const config = await loadConfig(tempDir);
    expect(config.sourceApiVersion).toBe('61.0');
  });

  it('derives defaultSourcePath from packageDirectories with /main/default suffix', async () => {
    const config = await loadConfig(tempDir);
    // config.js appends '/main/default' to the package path
    expect(config.defaultSourcePath).toBe('force-app/main/default');
  });

  it('loads testConfig.testClasses from test-config.json', async () => {
    const config = await loadConfig(tempDir);
    expect(config.testConfig.testClasses).toEqual(['AccountServiceTest', 'OpportunityHandlerTest']);
  });

  it('sets _projectRoot to the temp directory', async () => {
    const config = await loadConfig(tempDir);
    expect(config._projectRoot).toBe(tempDir);
  });

  it('sets _configDir to the .sfdt directory inside tempDir', async () => {
    const config = await loadConfig(tempDir);
    expect(config._configDir).toBe(join(tempDir, '.sfdt'));
  });

  it('reads projectName from config.json', async () => {
    const config = await loadConfig(tempDir);
    expect(config.projectName).toBe('Test Project');
  });

  it('reads deployment.coverageThreshold from config.json', async () => {
    const config = await loadConfig(tempDir);
    expect(config.deployment.coverageThreshold).toBe(80);
  });

  it('does not duplicate sourceApiVersion from sfdt-config.json (sfdx-project.json value wins when config does not set it)', async () => {
    // Our sfdt-config.json fixture does NOT contain sourceApiVersion.
    // loadConfig sets it only when !merged.sourceApiVersion, so the value
    // should be exactly the one from sfdx-project.json ('61.0'), not undefined
    // and not a duplicated/conflicting value.
    const config = await loadConfig(tempDir);
    expect(config.sourceApiVersion).toBe('61.0');
    // Confirm it is a single string, not an array or object
    expect(typeof config.sourceApiVersion).toBe('string');
  });
});
