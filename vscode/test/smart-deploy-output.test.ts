import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  parseSmartDeployOutput,
  summaryLines,
  isValidationJobId,
  buildQuickDeployCommand,
} from '../src/lib/smart-deploy-output.js';

// Canned output mirroring the CLI's print statements in src/commands/deploy.js
// (runSmartDeploy): print.header wraps the title in dashed rules; print.info/
// print.warning indent by two spaces.
const VALIDATE_OK = [
  '',
  '--------------------------------------------------',
  '  Smart deploy (main...HEAD) → devorg [validate]',
  '--------------------------------------------------',
  '',
  '  Delta: 3 additive, 1 destructive component(s).',
  '  Overwrite-protected (skipped): 2 component(s).',
  '  Test level: RunSpecifiedTests (FooTest, BarTest) — only Apex test classes changed',
  '  2 changed file(s) could not be mapped to a metadata type (skipped).',
  '  Running: sf project deploy validate --manifest /tmp/sfdt-smart-x/package.xml --target-org devorg --test-level RunSpecifiedTests --tests FooTest --tests BarTest',
  'Deploying v63.0 metadata to devorg using the v63.0 SOAP API.',
  '  Validation succeeded — no changes applied.',
].join('\n');

const VALIDATE_PROD = [
  '--------------------------------------------------',
  '  Smart deploy (release/1.2...HEAD) → My Prod Org [PRODUCTION] [validate]',
  '--------------------------------------------------',
  '',
  '  Delta: 12 additive, 0 destructive component(s).',
  '  Test level: RunLocalTests — production deploy',
  '  Running: sf project deploy validate --manifest /tmp/p/package.xml --target-org My Prod Org --test-level RunLocalTests',
  '  Validation succeeded — no changes applied.',
].join('\n');

describe('stripAnsi', () => {
  it('removes color escapes but not bracketed words', () => {
    expect(stripAnsi('[36m  Delta: 1 additive[39m')).toBe('  Delta: 1 additive');
    expect(stripAnsi('org [PRODUCTION] [validate]')).toBe('org [PRODUCTION] [validate]');
  });
});

describe('parseSmartDeployOutput', () => {
  it('parses the full non-prod validate summary', () => {
    const s = parseSmartDeployOutput(VALIDATE_OK);
    expect(s.base).toBe('main');
    expect(s.head).toBe('HEAD');
    expect(s.org).toBe('devorg');
    expect(s.production).toBe(false);
    expect(s.addCount).toBe(3);
    expect(s.delCount).toBe(1);
    expect(s.overwriteProtected).toBe(2);
    expect(s.unmappedCount).toBe(2);
    expect(s.testLevel).toBe('RunSpecifiedTests');
    expect(s.tests).toEqual(['FooTest', 'BarTest']);
    expect(s.testReason).toBe('only Apex test classes changed');
    expect(s.noChanges).toBe(false);
    expect(s.succeeded).toBe(true);
    expect(s.failed).toBe(false);
  });

  it('detects the production marker and orgs with spaces', () => {
    const s = parseSmartDeployOutput(VALIDATE_PROD);
    expect(s.org).toBe('My Prod Org');
    expect(s.production).toBe(true);
    expect(s.testLevel).toBe('RunLocalTests');
    expect(s.tests).toEqual([]);
    expect(s.testReason).toBe('production deploy');
    expect(s.succeeded).toBe(true);
  });

  it('parses ANSI-colored output', () => {
    const colored = VALIDATE_OK.split('\n').map((l) => `[36m${l}[39m`).join('\n');
    const s = parseSmartDeployOutput(colored);
    expect(s.addCount).toBe(3);
    expect(s.succeeded).toBe(true);
  });

  it('reports an empty delta', () => {
    const s = parseSmartDeployOutput(
      '  Smart deploy (main...HEAD) → devorg [validate]\n  No metadata changes detected between refs — nothing to deploy.',
    );
    expect(s.noChanges).toBe(true);
    expect(s.succeeded).toBe(false);
    expect(s.addCount).toBeNull();
  });

  it('reports a failed validation', () => {
    const s = parseSmartDeployOutput(
      '  Delta: 2 additive, 0 destructive component(s).\n  Test level: RunLocalTests — impacting types changed: ApexClass\n  Smart deploy failed.',
    );
    expect(s.failed).toBe(true);
    expect(s.succeeded).toBe(false);
  });

  it('captures preflight and setup failure detail', () => {
    const pf = parseSmartDeployOutput('  Preflight failed — aborting deploy: Script "ops/preflight.sh" exited with code 1');
    expect(pf.failed).toBe(true);
    expect(pf.failureDetail).toContain('preflight.sh');
    const setup = parseSmartDeployOutput('  Deployment failed: No org specified — pass --org <alias> or set defaultOrg in .sfdt/config.json');
    expect(setup.failed).toBe(true);
    expect(setup.failureDetail).toContain('No org specified');
  });

  it('flags production even when only the raw output carries the marker', () => {
    const s = parseSmartDeployOutput('some stray line [PRODUCTION]\n  Delta: 1 additive, 0 destructive component(s).');
    expect(s.production).toBe(true);
  });

  it('never throws on empty or junk output', () => {
    expect(parseSmartDeployOutput('').failed).toBe(false);
    const s = parseSmartDeployOutput('random\n{not json}\nnoise');
    expect(s.addCount).toBeNull();
    expect(s.succeeded).toBe(false);
  });
});

describe('summaryLines', () => {
  it('renders the parsed summary', () => {
    const lines = summaryLines(parseSmartDeployOutput(VALIDATE_OK));
    expect(lines).toContain('Org: devorg');
    expect(lines).toContain('Delta: 3 additive, 1 destructive component(s)');
    expect(lines).toContain('Test level: RunSpecifiedTests (FooTest, BarTest) — only Apex test classes changed');
    expect(lines).toContain('Overwrite-protected (skipped): 2 component(s)');
    expect(lines).toContain('Unmapped changed files (skipped): 2');
  });
  it('marks production orgs loudly', () => {
    const lines = summaryLines(parseSmartDeployOutput(VALIDATE_PROD));
    expect(lines[0]).toContain('PRODUCTION');
  });
  it('short-circuits on an empty delta', () => {
    const lines = summaryLines(parseSmartDeployOutput('  No metadata changes detected between refs — nothing to deploy.'));
    expect(lines).toEqual(['No metadata changes detected — nothing to deploy.']);
  });
});

describe('isValidationJobId', () => {
  it('accepts 15- and 18-char 0Af ids', () => {
    expect(isValidationJobId('0Af5g00000KxYzD')).toBe(true);
    expect(isValidationJobId('0Af5g00000KxYzDcAB')).toBe(true);
  });
  it('rejects wrong prefixes, lengths, and characters', () => {
    expect(isValidationJobId('0055g00000KxYzD')).toBe(false);
    expect(isValidationJobId('0Af5g00000KxYz')).toBe(false);
    expect(isValidationJobId('0Af5g00000KxYzDc')).toBe(false);
    expect(isValidationJobId('0Af5g00000KxYzD; rm -rf /')).toBe(false);
    expect(isValidationJobId(' 0Af5g00000KxYzD')).toBe(false);
    expect(isValidationJobId('')).toBe(false);
  });
});

describe('buildQuickDeployCommand', () => {
  // The command targets the sf CLI directly: the sfdt deployment-assistant
  // path can't promote a smart-deploy validation job (its quick-deploy
  // confirm read is not SFDT_NON_INTERACTIVE-gated and its non-interactive
  // branch requires — and would archive/tag — a manifest/release manifest).
  it('builds the direct sf quick-deploy command', () => {
    expect(buildQuickDeployCommand({ jobId: '0Af5g00000KxYzD', org: 'dev' })).toBe(
      'sf project deploy quick --job-id 0Af5g00000KxYzD --target-org dev',
    );
  });
  it('quotes an org alias with spaces', () => {
    expect(buildQuickDeployCommand({ jobId: '0Af5g00000KxYzD', org: 'My Org' })).toBe(
      `sf project deploy quick --job-id 0Af5g00000KxYzD --target-org 'My Org'`,
    );
  });
  it('omits the org when not given', () => {
    expect(buildQuickDeployCommand({ jobId: '0Af5g00000KxYzD' })).toBe(
      'sf project deploy quick --job-id 0Af5g00000KxYzD',
    );
  });
  it('contains no shell redirects or env prefixes (PowerShell-safe)', () => {
    const cmd = buildQuickDeployCommand({ jobId: '0Af5g00000KxYzD', org: 'dev' });
    expect(cmd).not.toMatch(/[<>]|SFDT_/);
  });
});
