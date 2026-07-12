import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs-extra';
import yaml from 'js-yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACTION_PATH = path.resolve(__dirname, '..', 'action.yml');

// Inputs that carry secrets: they must only reach shell code through step-level
// env: mappings, never interpolated into a run: body (where a crafted value
// could inject shell).
const SECRET_INPUTS = ['sfdx-auth-url', 'consumer-key', 'jwt-secret-key'];

let action;

beforeAll(async () => {
  action = yaml.load(await fs.readFile(ACTION_PATH, 'utf-8'));
});

describe('root composite action (action.yml)', () => {
  it('is a composite action with Marketplace branding', () => {
    expect(action.runs.using).toBe('composite');
    expect(action.name).toBeTruthy();
    expect(action.description).toBeTruthy();
    expect(action.branding.icon).toBeTruthy();
    expect(action.branding.color).toBeTruthy();
  });

  it('declares the expected input surface', () => {
    const inputs = Object.keys(action.inputs);
    for (const name of [
      'command', 'cli-version', 'auth-method',
      'sfdx-auth-url', 'consumer-key', 'jwt-secret-key', 'username', 'instance-url',
      'org-alias', 'node-version',
    ]) {
      expect(inputs, `missing input ${name}`).toContain(name);
    }
    expect(action.inputs.command.required).toBe(true);
    expect(action.inputs['cli-version'].default).toBe('auto');
    expect(action.inputs['auth-method'].default).toBe('none');
  });

  it('never interpolates secret inputs into run bodies (env-only)', () => {
    for (const step of action.runs.steps) {
      if (!step.run) continue;
      for (const name of SECRET_INPUTS) {
        expect(step.run, `step "${step.name}" interpolates inputs.${name} into its script`)
          .not.toContain(`inputs.${name}`);
      }
      // env values may reference inputs — that is the supported path.
    }
  });

  it('resolves cli-version auto with fallbacks for local uses: ./ invocations', () => {
    const install = action.runs.steps.find((s) => s.name === 'Install sfdt CLI');
    // github.action_path is unreliable for local actions (actions/runner#716):
    // the resolution must chain through the env var and the workspace, and must
    // never concatenate a possibly-undefined env value into require().
    expect(install.run).toContain('${{ github.action_path }}');
    expect(install.run).toContain('GITHUB_ACTION_PATH:-');
    expect(install.run).toContain('GITHUB_WORKSPACE');
    expect(install.run).not.toContain('process.env.GITHUB_ACTION_PATH +');
  });

  it('cleans up the JWT key file and falls back to the default login URL', () => {
    const jwt = action.runs.steps.find((s) => s.name === 'Authenticate (JWT)');
    expect(jwt.if).toContain("== 'jwt'");
    expect(jwt.run).toContain("trap 'rm -f");
    expect(jwt.run).toContain('${SFDX_INSTANCE_URL:-https://login.salesforce.com}');
  });

  it('every run step declares bash explicitly (composite requirement)', () => {
    for (const step of action.runs.steps) {
      if (step.run) expect(step.shell, `step "${step.name}" is missing shell:`).toBe('bash');
    }
  });
});
