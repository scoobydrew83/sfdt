import { describe, it, expect } from 'vitest';
import { injectBlock, commentBlock, loadPartial, authSecretsDoc, authSecretNames } from '../../src/lib/ci-templates.js';

describe('injectBlock', () => {
  it('re-indents every block line to the placeholder indentation', () => {
    const template = 'steps:\n      {{authSteps}}\n      - run: done\n';
    const block = '- name: login\n  run: sf org login\n';
    const out = injectBlock(template, 'authSteps', block);
    expect(out).toBe('steps:\n      - name: login\n        run: sf org login\n      - run: done\n');
  });

  it('inserts $-sequences literally (GitHub secret expressions)', () => {
    const out = injectBlock('  {{authSteps}}\n', 'authSteps', 'run: ${{ secrets.SFDX_AUTH_URL }}');
    expect(out).toContain('${{ secrets.SFDX_AUTH_URL }}');
  });

  it('removes the placeholder line entirely for an empty block', () => {
    const out = injectBlock('a:\n  {{cliSetup}}\n  b: 1\n', 'cliSetup', '');
    expect(out).toBe('a:\n  b: 1\n');
  });

  it('leaves the template untouched when the placeholder is absent', () => {
    const template = 'a: 1\n';
    expect(injectBlock(template, 'authSteps', '- x')).toBe(template);
  });

  it('preserves scalar placeholders inside the block for the interpolate pass', () => {
    const out = injectBlock('  {{authSteps}}\n', 'authSteps', '- run: login --alias {{org}}');
    expect(out).toContain('{{org}}');
  });
});

describe('commentBlock', () => {
  it('prefixes every non-empty line with a comment marker', () => {
    expect(commentBlock('- a\n  b\n\n- c')).toBe('# - a\n#   b\n#\n# - c');
  });
});

describe('partials', () => {
  it('loads a shipped partial and trims trailing whitespace', async () => {
    const p = await loadPartial('github-auth-sfdx-url');
    expect(p).toContain('sfdx-url-stdin');
    expect(p).not.toMatch(/\s$/);
  });

  it('throws a descriptive error for a missing partial', async () => {
    await expect(loadPartial('github-auth-oauth')).rejects.toThrow('No CI partial');
  });
});

describe('auth docs', () => {
  it('documents both auth methods', () => {
    expect(authSecretsDoc('sfdx-url')).toContain('SFDX_AUTH_URL');
    expect(authSecretsDoc('jwt')).toContain('SFDX_JWT_SECRET_KEY');
    expect(authSecretNames('jwt')).toContain('SFDX_CONSUMER_KEY');
  });
});
