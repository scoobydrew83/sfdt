import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));
vi.mock('../../src/lib/org-rest.js', () => ({
  orgRest: vi.fn(),
  restErrorMessage: vi.fn((e) => e?.message ?? 'unknown error'),
}));
vi.mock('../../src/lib/permissions-runner.js', () => ({ runPermissionDrift: vi.fn() }));

import { query } from '../../src/lib/org-query.js';
import { orgRest } from '../../src/lib/org-rest.js';
import { runPermissionDrift } from '../../src/lib/permissions-runner.js';
import {
  resolveParent,
  applyPermissionChange,
  applyDriftFix,
} from '../../src/lib/permissions-write-runner.js';
import { readLedger, foldEntries, undoChange } from '../../src/lib/ledger.js';

let logDir;
let config;

beforeEach(async () => {
  logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-permw-'));
  config = { _projectRoot: logDir, logDir, sourceApiVersion: 62 };
  vi.mocked(query).mockReset().mockResolvedValue([]);
  vi.mocked(orgRest).mockReset().mockResolvedValue({ id: 'x', success: true });
  vi.mocked(runPermissionDrift).mockReset();
});

afterEach(async () => {
  await fs.remove(logDir);
});

const PERMSET = { Id: '0PS1', Label: 'Sales Ops', IsOwnedByProfile: false };

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

describe('resolveParent', () => {
  it('REFUSES a profile, naming why, before any write', async () => {
    // Salesforce does not permit direct DML on profile-owned permission
    // entries. Refusing by name beats an opaque INSUFFICIENT_ACCESS from the
    // org, which reads like a problem with the user's own access.
    routeQueries([[/FROM PermissionSet/, [
      { Id: '0PS9', Label: 'Admin', IsOwnedByProfile: true, Profile: { Name: 'System Administrator' } },
    ]]]);

    await expect(resolveParent('dev', 'Admin')).rejects.toThrow(/is a PROFILE/);
    await expect(resolveParent('dev', 'Admin')).rejects.toThrow(/Metadata API/);
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('resolves a real permission set', async () => {
    routeQueries([[/FROM PermissionSet/, [PERMSET]]]);
    await expect(resolveParent('dev', 'Sales Ops')).resolves.toEqual({ id: '0PS1', label: 'Sales Ops' });
  });

  it('refuses an ambiguous label rather than picking one', async () => {
    routeQueries([[/FROM PermissionSet/, [PERMSET, { ...PERMSET, Id: '0PS2' }]]]);
    await expect(resolveParent('dev', 'Sales Ops')).rejects.toThrow(/use the exact API name/);
  });

  it('errors clearly when nothing matches', async () => {
    routeQueries([[/FROM PermissionSet/, []]]);
    await expect(resolveParent('dev', 'Nope')).rejects.toThrow(/No permission set named/);
  });

  it('escapes the BACKSLASH as well as the quote, so a label cannot break out of the literal', async () => {
    // Escaping only `'` leaves a trailing backslash escaping the closing
    // delimiter instead — `'Ops\'` — which ends the literal early and lets the
    // rest of the label be read as SOQL. This is a permission-GRANTING path, so
    // it uses flow-core's escapeSoql like every other query builder here.
    let seen = '';
    vi.mocked(query).mockImplementation(async (_org, soql) => {
      seen = soql;
      return [PERMSET];
    });

    await resolveParent('dev', "Ops\\");

    expect(seen).toContain("Label = 'Ops\\\\'");
    expect(seen).not.toContain("'Ops\\'");
  });
});

describe('applyPermissionChange', () => {
  const grant = (over = {}) => ({
    parent: 'Sales Ops',
    fields: ['Account.Region__c'],
    level: 'read',
    logDir,
    ...over,
  });

  it('POSTs a new row when the parent has no grant yet', async () => {
    // Salesforce models "no access" as the ABSENCE of a row, so three shapes
    // are needed and picking the wrong one fails opaquely.
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);

    await applyPermissionChange(config, 'dev', grant());

    const [, url, opts] = vi.mocked(orgRest).mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(url).toContain('/sobjects/FieldPermissions');
    expect(opts.body).toMatchObject({
      ParentId: '0PS1', SobjectType: 'Account', Field: 'Account.Region__c',
      PermissionsRead: true, PermissionsEdit: false,
    });
  });

  it('PATCHes an existing row', async () => {
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);

    await applyPermissionChange(config, 'dev', grant({ level: 'edit' }));

    const [, url, opts] = vi.mocked(orgRest).mock.calls[0];
    expect(opts.method).toBe('PATCH');
    expect(url).toContain('/FP1');
    expect(opts.body).toEqual({ PermissionsRead: true, PermissionsEdit: true });
  });

  it('DELETEs the row to remove access', async () => {
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);

    await applyPermissionChange(config, 'dev', grant({ level: 'none' }));
    expect(vi.mocked(orgRest).mock.calls[0][2].method).toBe('DELETE');
  });

  it('sends read alongside edit — the org rejects edit without it', async () => {
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);
    await applyPermissionChange(config, 'dev', grant({ level: 'edit' }));

    expect(vi.mocked(orgRest).mock.calls[0][2].body).toMatchObject({
      PermissionsRead: true, PermissionsEdit: true,
    });
  });

  it('records the prior level in the ledger before writing', async () => {
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);

    const result = await applyPermissionChange(config, 'dev', grant({ level: 'edit' }));
    const intent = (await readLedger(logDir)).find((e) => e.kind === 'permissions.field');

    expect(intent.before.fields).toEqual([{ field: 'Account.Region__c', level: 'read' }]);
    expect(intent.after.fields).toEqual([{ field: 'Account.Region__c', level: 'edit' }]);
    expect(result.ledgerId).toBe(intent.id);
  });

  it('writes nothing on --dry-run and records nothing', async () => {
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);

    const result = await applyPermissionChange(config, 'dev', grant({ dryRun: true }));
    expect(result.outcome).toBe('dry-run');
    expect(orgRest).not.toHaveBeenCalled();
    expect(await readLedger(logDir)).toEqual([]);
  });

  it('is a no-op when every field is already at that level', async () => {
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);

    const result = await applyPermissionChange(config, 'dev', grant({ level: 'read' }));
    expect(result.outcome).toBe('no-op');
    expect(orgRest).not.toHaveBeenCalled();
  });

  it('reports a PARTIAL application honestly and points at the undo', async () => {
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);
    vi.mocked(orgRest)
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('FIELD_INTEGRITY_EXCEPTION'));

    await expect(
      applyPermissionChange(config, 'dev', grant({ fields: ['Account.A__c', 'Account.B__c'] })),
    ).rejects.toThrow(/1 of 2 change\(s\) were applied/);

    expect(foldEntries(await readLedger(logDir))[0].status).toBe('failed');
  });

  it('rejects an unknown level before touching the org', async () => {
    await expect(applyPermissionChange(config, 'dev', grant({ level: 'admin' }))).rejects.toThrow(/--level/);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('undo restores the prior grants', () => {
  it('puts each field back, and no-ops one already restored', async () => {
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);
    const result = await applyPermissionChange(config, 'dev', {
      parent: 'Sales Ops', fields: ['Account.Region__c'], level: 'edit', logDir,
    });

    // Current state now reads back as `edit`, so undo has real work to do.
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: true }]],
    ]);
    vi.mocked(orgRest).mockClear();

    const undone = await undoChange(logDir, result.ledgerId, { org: 'dev', config });
    expect(undone.result.restored).toEqual([
      { field: 'Account.Region__c', level: 'read', action: 'updated' },
    ]);
    expect(vi.mocked(orgRest).mock.calls[0][2].body).toEqual({
      PermissionsRead: true, PermissionsEdit: false,
    });
  });

  it('is idempotent — a field already back at its recorded level is a no-op', async () => {
    // Which is what makes a partially-applied change undo cleanly.
    routeQueries([
      [/FROM PermissionSet/, [PERMSET]],
      [/FROM FieldPermissions/, [{ Id: 'FP1', PermissionsRead: true, PermissionsEdit: false }]],
    ]);
    const result = await applyPermissionChange(config, 'dev', {
      parent: 'Sales Ops', fields: ['Account.Region__c'], level: 'edit', logDir,
    });

    vi.mocked(orgRest).mockClear();
    const undone = await undoChange(logDir, result.ledgerId, { org: 'dev', config });

    expect(undone.result.restored[0].action).toBe('no-op');
    expect(orgRest).not.toHaveBeenCalled();
  });
});

describe('applyDriftFix — the bulk fix', () => {
  it('applies ONLY what the org is missing, never revoking extras', async () => {
    // Removing access nobody asked to remove is a different and riskier
    // decision than granting what source already declares.
    vi.mocked(runPermissionDrift).mockResolvedValue({
      object: 'Account',
      rows: [
        { parent: 'Sales Ops', field: 'Region__c', org: 'none', repo: 'read', verdict: 'missing-in-org' },
        { parent: 'Sales Ops', field: 'Secret__c', org: 'edit', repo: 'none', verdict: 'extra-in-org' },
      ],
      notes: [],
    });
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);

    const result = await applyDriftFix(config, 'dev', 'Account', { logDir });

    expect(orgRest).toHaveBeenCalledTimes(1);
    expect(vi.mocked(orgRest).mock.calls[0][2].body.Field).toBe('Account.Region__c');
    expect(result.notes.some((n) => n.includes('extra-in-org'))).toBe(true);
  });

  it('groups by level so each batch is one intended state', async () => {
    // The repo may declare read for one field and edit for another.
    vi.mocked(runPermissionDrift).mockResolvedValue({
      object: 'Account',
      rows: [
        { parent: 'Sales Ops', field: 'A__c', org: 'none', repo: 'read', verdict: 'missing-in-org' },
        { parent: 'Sales Ops', field: 'B__c', org: 'none', repo: 'edit', verdict: 'missing-in-org' },
      ],
      notes: [],
    });
    routeQueries([[/FROM PermissionSet/, [PERMSET]], [/FROM FieldPermissions/, []]]);

    const result = await applyDriftFix(config, 'dev', 'Account', { logDir });

    expect(result.results).toHaveLength(2);
    const levels = vi.mocked(orgRest).mock.calls.map(([, , o]) => o.body.PermissionsEdit);
    expect(levels.sort()).toEqual([false, true]);
  });

  it('is a no-op when the org already matches source', async () => {
    vi.mocked(runPermissionDrift).mockResolvedValue({ object: 'Account', rows: [], notes: [] });

    const result = await applyDriftFix(config, 'dev', 'Account', { logDir });
    expect(result.outcome).toBe('no-op');
    expect(orgRest).not.toHaveBeenCalled();
  });
});
