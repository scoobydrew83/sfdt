import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import os from 'os';
import yaml from 'js-yaml';

vi.mock('../../src/lib/config.js', () => ({ loadConfig: vi.fn() }));
import { loadConfig } from '../../src/lib/config.js';
import { generateCi } from '../../src/commands/ci.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_DIR = path.resolve(__dirname, '..', 'fixtures', 'ci-golden');

const PROVIDERS = ['github', 'gitlab', 'azure', 'bitbucket'];
const ALL_TYPES = ['monitor', 'deploy', 'release', 'scratch'];

const stripComments = (s) =>
  s
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

beforeEach(() => {
  vi.resetAllMocks();
  loadConfig.mockResolvedValue({ defaultOrg: 'devhub' });
});

describe('generateCi', () => {
  it('interpolates cron, org, and node into a github monitor template', async () => {
    const r = await generateCi({ provider: 'github', type: 'monitor', cron: '15 3 * * 1', node: '22' });
    expect(r.content).toContain("cron: '15 3 * * 1'");
    expect(r.content).toContain('--org devhub');
    expect(r.content).toContain("node-version: '22'");
    // GitHub ${{ secrets.X }} expressions must survive interpolation untouched.
    expect(r.content).toContain('${{ secrets.SFDX_AUTH_URL }}');
    expect(r.content).not.toMatch(/\{\{(cron|org|nodeVersion|deltaBase)\}\}/);
  });

  it('interpolates the delta base into a deploy template', async () => {
    const r = await generateCi({ provider: 'gitlab', type: 'deploy', org: 'uat' });
    expect(r.content).toContain('--org uat');
    expect(r.type).toBe('deploy');
  });

  it('falls back to a placeholder org when none is configured', async () => {
    loadConfig.mockRejectedValueOnce(new Error('no project'));
    const r = await generateCi({ provider: 'github', type: 'monitor' });
    expect(r.orgMissing).toBe(true);
    expect(r.content).toContain('YOUR_ORG_ALIAS');
  });

  it('rejects an unknown provider', async () => {
    await expect(generateCi({ provider: 'jenkins', type: 'monitor' })).rejects.toThrow('--provider');
  });

  it('rejects an unknown type', async () => {
    await expect(generateCi({ provider: 'github', type: 'bogus' })).rejects.toThrow('--type');
  });

  it('produces valid YAML with no leftover placeholders for every provider/type/auth combination', async () => {
    for (const provider of PROVIDERS) {
      for (const type of ALL_TYPES) {
        for (const auth of ['sfdx-url', 'jwt']) {
          const r = await generateCi({ provider, type, auth, org: 'x' });
          expect(r.content.length).toBeGreaterThan(0);
          expect(r.content, `${provider}/${type}/${auth}`).not.toMatch(/\{\{\w+\}\}/);
          expect(() => yaml.load(r.content), `${provider}/${type}/${auth} must parse as YAML`).not.toThrow();
        }
      }
    }
  });
});

describe('generateCi — back-compat with pre-partials output', () => {
  // The golden fixtures capture the rendered output (org golden-org, comment
  // lines stripped) from before the auth/quality partial refactor. Monitor
  // templates must render identically; deploy templates gain steps (quality
  // scan, permissions) but every original line must survive, in order.
  it.each(PROVIDERS)('%s monitor renders identically to the golden output', async (provider) => {
    const golden = await fs.readFile(path.join(GOLDEN_DIR, `${provider}-monitor.yml`), 'utf-8');
    const r = await generateCi({ provider, type: 'monitor', org: 'golden-org' });
    expect(stripComments(r.content)).toBe(golden);
  });

  it.each(PROVIDERS)('%s deploy keeps every golden line, in order', async (provider) => {
    const golden = (await fs.readFile(path.join(GOLDEN_DIR, `${provider}-deploy.yml`), 'utf-8'))
      .split('\n')
      .filter((l) => l.trim());
    const rendered = stripComments((await generateCi({ provider, type: 'deploy', org: 'golden-org' })).content).split('\n');
    let cursor = 0;
    for (const line of golden) {
      const found = rendered.indexOf(line, cursor);
      expect(found, `missing or out-of-order line in ${provider}-deploy: ${line}`).toBeGreaterThanOrEqual(cursor);
      cursor = found + 1;
    }
  });
});

describe('generateCi — auth methods', () => {
  it.each(PROVIDERS)('%s renders the JWT login flow with --auth jwt', async (provider) => {
    const r = await generateCi({ provider, type: 'deploy', auth: 'jwt', org: 'uat' });
    expect(r.auth).toBe('jwt');
    expect(r.content).toContain('sf org login jwt');
    expect(r.content).toContain('--client-id');
    expect(r.content).toContain('SFDX_JWT_SECRET_KEY');
    expect(r.content).toContain('rm -f server.key');
    expect(r.content).not.toContain('sfdx-url-stdin');
  });

  it('github JWT partial references environment secrets untouched', async () => {
    const r = await generateCi({ provider: 'github', type: 'deploy', auth: 'jwt', org: 'uat' });
    expect(r.content).toContain('${{ secrets.SFDX_CONSUMER_KEY }}');
    expect(r.content).toContain('${{ secrets.SFDX_USERNAME }}');
  });

  it('documents the JWT secrets in the header comments', async () => {
    const r = await generateCi({ provider: 'gitlab', type: 'monitor', auth: 'jwt', org: 'uat' });
    expect(r.content).toContain('SFDX_CONSUMER_KEY');
    expect(r.content).toContain('not a file path');
  });

  it('defaults to the config ci.authMethod when no flag is passed', async () => {
    loadConfig.mockResolvedValue({ defaultOrg: 'devhub', ci: { authMethod: 'jwt' } });
    const r = await generateCi({ provider: 'github', type: 'monitor' });
    expect(r.auth).toBe('jwt');
    expect(r.content).toContain('sf org login jwt');
  });

  it('rejects an unknown auth method', async () => {
    await expect(generateCi({ provider: 'github', type: 'deploy', auth: 'oauth' })).rejects.toThrow('--auth');
  });
});

describe('generateCi — release type', () => {
  it('github release deploys for real inside the approval environment', async () => {
    const r = await generateCi({ provider: 'github', type: 'release', org: 'prod', branch: 'main', environment: 'production' });
    expect(r.content).toContain('environment: production');
    expect(r.content).toContain("branches: ['main']");
    expect(r.content).toContain('git describe --tags --abbrev=0');
    expect(r.content).toContain('--delta-base "$BASE"');
    expect(r.content).toContain('--notify');
    expect(r.content).not.toContain('--dry-run');
  });

  it('resolves branch/environment from config defaults', async () => {
    loadConfig.mockResolvedValue({ defaultOrg: 'prod', defaultBranch: 'release', ci: { environment: 'uat' } });
    const r = await generateCi({ provider: 'gitlab', type: 'release' });
    expect(r.content).toContain('$CI_COMMIT_BRANCH == "release"');
    expect(r.content).toContain('name: uat');
  });

  it('uses HEAD~1 as the no-tags fallback and honours --delta-base overrides', async () => {
    const fallback = await generateCi({ provider: 'bitbucket', type: 'release', org: 'prod' });
    expect(fallback.content).toContain('echo "HEAD~1"');
    const pinned = await generateCi({ provider: 'bitbucket', type: 'release', org: 'prod', deltaBase: 'v1.2.3' });
    expect(pinned.content).toContain('echo "v1.2.3"');
  });

  it('azure release uses a deployment job (approvals require one)', async () => {
    const r = await generateCi({ provider: 'azure', type: 'release', org: 'prod' });
    expect(r.content).toContain('- deployment: sfdt_release');
    expect(r.content).toContain('runOnce');
  });

  it('gitlab release is manual and environment-bound', async () => {
    const r = await generateCi({ provider: 'gitlab', type: 'release', org: 'prod' });
    expect(r.content).toContain('when: manual');
    expect(r.content).toMatch(/environment:\s*\n\s*name: production/);
  });
});

describe('generateCi — quality gate', () => {
  it('github deploy uploads SARIF to code scanning with the required permission', async () => {
    const r = await generateCi({ provider: 'github', type: 'deploy', org: 'uat' });
    expect(r.content).toContain('quality --output-file sfdt-quality.sarif');
    expect(r.content).toContain('github/codeql-action/upload-sarif@v3');
    expect(r.content).toContain('security-events: write');
    expect(r.content).toContain('continue-on-error: true');
  });

  it.each(['gitlab', 'azure', 'bitbucket'])('%s deploy runs an advisory quality scan', async (provider) => {
    const r = await generateCi({ provider, type: 'deploy', org: 'uat' });
    expect(r.content).toContain('quality || true');
  });

  it('monitor templates carry no quality step', async () => {
    const r = await generateCi({ provider: 'github', type: 'monitor', org: 'uat' });
    expect(r.content).not.toContain('quality');
  });
});

describe('generateCi — docker runner', () => {
  it.each(['gitlab', 'bitbucket'])('%s --runner docker uses the sfdt image and skips CLI installs', async (provider) => {
    const r = await generateCi({ provider, type: 'deploy', runner: 'docker', org: 'uat' });
    expect(r.runner).toBe('docker');
    expect(r.content).toContain('image: ghcr.io/scoobydrew83/sfdt:latest');
    expect(r.content).not.toContain('npm install --global @salesforce/cli');
    expect(r.content).not.toContain('npx --yes @sfdt/cli@latest');
    expect(r.content).toContain('sfdt deploy --smart');
  });

  it('defaults to npx: node image plus per-run installs', async () => {
    const r = await generateCi({ provider: 'gitlab', type: 'deploy', org: 'uat', node: '22' });
    expect(r.content).toContain('image: node:22');
    expect(r.content).toContain('npm install --global @salesforce/cli');
    expect(r.content).toContain('npx --yes @sfdt/cli@latest deploy --smart');
  });

  it('rejects --runner docker for providers on hosted runners', async () => {
    await expect(generateCi({ provider: 'github', type: 'deploy', runner: 'docker' })).rejects.toThrow('--runner docker');
  });

  it('rejects an unknown runner', async () => {
    await expect(generateCi({ provider: 'gitlab', type: 'deploy', runner: 'podman' })).rejects.toThrow('--runner');
  });
});

describe('generateCi — scratch type', () => {
  it('authenticates the Dev Hub and always deletes the scratch org', async () => {
    const r = await generateCi({ provider: 'github', type: 'scratch', org: 'devhub' });
    expect(r.content).toContain('--set-default-dev-hub');
    expect(r.content).toContain('sf org create scratch');
    expect(r.content).toContain('sf project deploy start');
    expect(r.content).toContain('sf apex run test');
    expect(r.content).toContain('sf org delete scratch --target-org sfdt-ci --no-prompt');
    expect(r.content).toContain('if: always()');
  });

  it('interpolates the scratch definition file from flag or config', async () => {
    loadConfig.mockResolvedValue({ defaultOrg: 'devhub', scratch: { definitionFile: 'config/dev.json' } });
    const fromConfig = await generateCi({ provider: 'gitlab', type: 'scratch' });
    expect(fromConfig.content).toContain('--definition-file config/dev.json');
    const fromFlag = await generateCi({ provider: 'gitlab', type: 'scratch', definitionFile: 'config/qa.json' });
    expect(fromFlag.content).toContain('--definition-file config/qa.json');
  });

  it('emits the LWC test step commented out when no Jest setup is detected', async () => {
    const r = await generateCi({ provider: 'github', type: 'scratch', org: 'devhub' });
    expect(r.content).toContain('# Uncomment when the project has LWC (Jest) unit tests:');
    expect(r.content).toMatch(/# - name: Run LWC tests/);
  });

  it.each(['gitlab', 'bitbucket'])('%s cleans up via after-script', async (provider) => {
    const r = await generateCi({ provider, type: 'scratch', org: 'devhub' });
    expect(r.content).toMatch(/after[-_]script:/);
    expect(r.content).toContain('sf org delete scratch --target-org sfdt-ci --no-prompt || true');
  });
});

describe('runCiInit (write)', () => {
  it('writes the workflow to the requested --out path', async () => {
    const { runCiInit } = await import('../../src/commands/ci.js');
    const out = path.join(os.tmpdir(), `sfdt-ci-${process.pid}-${Date.now()}.yml`);
    await runCiInit({ provider: 'github', type: 'monitor', org: 'dev', out, json: true });
    expect(await fs.pathExists(out)).toBe(true);
    const written = await fs.readFile(out, 'utf-8');
    expect(written).toContain('SFDT Org Monitoring');
    await fs.remove(out);
  });
});
