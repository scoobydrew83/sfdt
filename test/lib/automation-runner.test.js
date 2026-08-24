import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import { query } from '../../src/lib/org-query.js';
import { findAutomationType } from '@sfdt/flow-core';
import {
  resolveTarget,
  fetchMetadata,
  flipStatusXml,
  setAutomationState,
} from '../../src/lib/automation-runner.js';
import { readLedger, foldEntries, undoChange, _resetReversersForTests } from '../../src/lib/ledger.js';
import { isProductionOrg, guardProduction } from '../../src/lib/org-facts.js';

// What is asserted here is what THIS layer decides: that a Metadata write is
// always preceded by a read, that the ledger records the before-state before the
// org is touched, and that the production guard fails safe.

let logDir;
let config;

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-auto-'));
  config = { _projectRoot: logDir, logDir };
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(execa).mockReset().mockResolvedValue({ stdout: '{"status":0}' });
});

afterEach(async () => {
  await fs.remove(logDir);
});

const VR = {
  Id: '03dx',
  ValidationName: 'Region_Required',
  Active: true,
  EntityDefinition: { QualifiedApiName: 'Account' },
};
const VR_METADATA = {
  active: true,
  errorConditionFormula: 'ISBLANK(Region__c)',
  errorMessage: 'Region is required',
  description: 'keep me',
};

/** Route SOQL by pattern. */
function routeQueries(handlers) {
  vi.mocked(query).mockImplementation(async (_org, soql) => {
    for (const [pattern, rows] of handlers) {
      if (pattern.test(soql)) {
        if (rows instanceof Error) throw rows;
        return rows;
      }
    }
    return [];
  });
}

describe('resolveTarget', () => {
  it('refuses an ambiguous bare name rather than toggling the wrong rule', async () => {
    // Validation rules are named per object, so the same name exists twice.
    routeQueries([[/FROM ValidationRule/, [
      { ...VR, Id: '1', EntityDefinition: { QualifiedApiName: 'Account' } },
      { ...VR, Id: '2', EntityDefinition: { QualifiedApiName: 'Contact' } },
    ]]]);

    await expect(resolveTarget('dev', 'validation-rule', 'Region_Required')).rejects.toThrow(
      /Qualify it as <Object>\.<Name>/,
    );
  });

  it('resolves a qualified Object.Name', async () => {
    routeQueries([[/FROM ValidationRule/, [
      { ...VR, Id: '1', EntityDefinition: { QualifiedApiName: 'Account' } },
      { ...VR, Id: '2', EntityDefinition: { QualifiedApiName: 'Contact' } },
    ]]]);

    const { row } = await resolveTarget('dev', 'validation-rule', 'Contact.Region_Required');
    expect(row.id).toBe('2');
  });

  it('errors clearly when nothing matches', async () => {
    routeQueries([[/FROM ValidationRule/, []]]);
    await expect(resolveTarget('dev', 'validation-rule', 'Nope')).rejects.toThrow(/No Validation rule named/);
  });
});

describe('fetchMetadata', () => {
  it('refuses to proceed when Metadata could not be read', async () => {
    // Writing without reading would replace the object with a single key.
    routeQueries([[/FROM ValidationRule/, [{ Id: '03dx', Metadata: null }]]]);

    await expect(fetchMetadata('dev', findAutomationType('validation-rule'), '03dx')).rejects.toThrow(
      /nothing safe to write back/,
    );
  });
});

describe('setAutomationState — Tooling path', () => {
  beforeEach(() => {
    routeQueries([
      [/FROM ValidationRule WHERE Id/, [{ Id: '03dx', Metadata: VR_METADATA }]],
      [/FROM ValidationRule/, [VR]],
    ]);
  });

  it('writes back the WHOLE Metadata object, not just the flag', async () => {
    // The single most destructive thing this feature could get wrong.
    await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, { logDir });

    const call = vi.mocked(execa).mock.calls.find(([, args]) => args?.includes('update'));
    const values = call[1][call[1].indexOf('--values') + 1];
    const written = JSON.parse(values.replace(/^Metadata=/, ''));

    expect(written).toEqual({ ...VR_METADATA, active: false });
    expect(written.errorConditionFormula).toBe('ISBLANK(Region__c)');
    expect(written.description).toBe('keep me');
  });

  it('records the before-state in the ledger BEFORE writing', async () => {
    const result = await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, { logDir });

    const entries = await readLedger(logDir);
    const intent = entries.find((e) => e.kind === 'automation.validation-rule');
    expect(intent.before.metadata).toEqual(VR_METADATA);
    expect(intent.after.metadata.active).toBe(false);
    expect(result.ledgerId).toBe(intent.id);
    expect(foldEntries(entries)[0].status).toBe('applied');
  });

  it('writes NOTHING on --dry-run, and records nothing', async () => {
    const result = await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, {
      dryRun: true, logDir,
    });

    expect(result.outcome).toBe('dry-run');
    expect(vi.mocked(execa).mock.calls.some(([, a]) => a?.includes('update'))).toBe(false);
    expect(await readLedger(logDir)).toEqual([]);
  });

  it('is a no-op when already in the requested state', async () => {
    const result = await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', true, { logDir });

    expect(result.outcome).toBe('no-op');
    expect(await readLedger(logDir)).toEqual([]);
  });

  it('records a failed write as failed rather than swallowing it', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('FIELD_INTEGRITY_EXCEPTION'));

    await expect(
      setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, { logDir }),
    ).rejects.toThrow('FIELD_INTEGRITY_EXCEPTION');

    expect(foldEntries(await readLedger(logDir))[0].status).toBe('failed');
  });

  it('carries the write-mechanism note out to the caller', async () => {
    const result = await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, { logDir });
    expect(result.writeNote).toContain('replaces rather than merges');
  });
});

describe('setAutomationState — flow', () => {
  it('deactivates by setting activeVersionNumber to 0', async () => {
    routeQueries([
      [/FROM FlowDefinition WHERE Id/, [{ Id: '300x', Metadata: { activeVersionNumber: 4 } }]],
      [/FROM FlowDefinition/, [
        { Id: '300x', DeveloperName: 'Set_Region', ActiveVersionId: '301x', ActiveVersion: { VersionNumber: 4 } },
      ]],
    ]);

    await setAutomationState(config, 'dev', 'flow', 'Set_Region', false, { logDir });

    const call = vi.mocked(execa).mock.calls.find(([, args]) => args?.includes('update'));
    const written = JSON.parse(call[1][call[1].indexOf('--values') + 1].replace(/^Metadata=/, ''));
    expect(written.activeVersionNumber).toBe(0);
  });

  it('records the version that WAS active — deactivating discards it', async () => {
    // Without this in the before-state, undo could not know which version to
    // put back and would have to guess.
    routeQueries([
      [/FROM FlowDefinition WHERE Id/, [{ Id: '300x', Metadata: { activeVersionNumber: 4 } }]],
      [/FROM FlowDefinition/, [
        { Id: '300x', DeveloperName: 'Set_Region', ActiveVersionId: '301x', ActiveVersion: { VersionNumber: 4 } },
      ]],
    ]);

    await setAutomationState(config, 'dev', 'flow', 'Set_Region', false, { logDir });
    const intent = (await readLedger(logDir)).find((e) => e.kind === 'automation.flow');

    expect(intent.before.metadata.activeVersionNumber).toBe(4);
  });
});

describe('flipStatusXml', () => {
  it('flips a trigger status', () => {
    const t = findAutomationType('apex-trigger');
    expect(flipStatusXml('<status>Active</status>', t, false)).toBe('<status>Inactive</status>');
    expect(flipStatusXml('<status>Inactive</status>', t, true)).toBe('<status>Active</status>');
  });

  it('flips a workflow rule active flag', () => {
    const t = findAutomationType('workflow-rule');
    expect(flipStatusXml('<active>true</active>', t, false)).toBe('<active>false</active>');
  });

  it('returns the input UNCHANGED when no flag is found, so the caller can refuse', () => {
    // Returning unchanged is the signal; the caller refuses to deploy rather
    // than guessing at an unfamiliar file shape.
    const t = findAutomationType('apex-trigger');
    expect(flipStatusXml('<somethingElse/>', t, false)).toBe('<somethingElse/>');
  });
});

describe('the production guard', () => {
  it('FAILS SAFE — an org whose sandbox status cannot be read is production', async () => {
    // Some org shapes omit isSandbox entirely. Reading undefined as "not
    // production" would drop the guard exactly where it matters most.
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: {} }) });
    expect(await isProductionOrg('x')).toBe(true);

    vi.mocked(execa).mockRejectedValue(new Error('no auth'));
    expect(await isProductionOrg('x')).toBe(true);
  });

  it('recognises a sandbox', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: { isSandbox: true } }) });
    expect(await isProductionOrg('x')).toBe(false);
  });

  it('refuses a production write without --production', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: { isSandbox: false } }) });
    await expect(guardProduction('prod', {}, 'change things')).rejects.toThrow(/Re-run with --production/);
  });

  it('allows a sandbox write without the flag', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: { isSandbox: true } }) });
    await expect(guardProduction('dev', {}, 'change things')).resolves.toMatchObject({ isProduction: false });
  });

  it('allows production when acknowledged', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: { isSandbox: false } }) });
    await expect(guardProduction('prod', { production: true }, 'x')).resolves.toMatchObject({ acknowledged: true });
  });
});

describe('undo restores the recorded Metadata verbatim', () => {
  it('writes back exactly what was read, with no re-derivation', async () => {
    routeQueries([
      [/FROM ValidationRule WHERE Id/, [{ Id: '03dx', Metadata: VR_METADATA }]],
      [/FROM ValidationRule/, [VR]],
    ]);
    const result = await setAutomationState(config, 'dev', 'validation-rule', 'Account.Region_Required', false, { logDir });

    vi.mocked(execa).mockClear();
    await undoChange(logDir, result.ledgerId, { org: 'dev', config });

    const call = vi.mocked(execa).mock.calls.find(([, args]) => args?.includes('update'));
    const written = JSON.parse(call[1][call[1].indexOf('--values') + 1].replace(/^Metadata=/, ''));
    // The whole original object, formula and all.
    expect(written).toEqual(VR_METADATA);
  });
});
