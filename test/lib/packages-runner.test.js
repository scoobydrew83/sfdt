import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

vi.mock('../../src/lib/org-query.js', () => ({ query: vi.fn() }));

import { query } from '../../src/lib/org-query.js';
import {
  readPackageNotes,
  writePackageNote,
  validateNote,
  listPackages,
  comparePackages,
  NOTES_FORMAT_VERSION,
} from '../../src/lib/packages-runner.js';

// The notes file is driven against a REAL temp directory rather than a mocked
// fs: what breaks here is path resolution and merge semantics, and a mocked fs
// would only assert my assumptions about them.

let root;
let config;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-packages-'));
  await fs.ensureDir(path.join(root, '.sfdt'));
  config = { _projectRoot: root, _configDir: path.join(root, '.sfdt') };
  vi.mocked(query).mockReset().mockResolvedValue([]);
});

afterEach(async () => {
  await fs.remove(root);
});

const notesFile = () => path.join(root, '.sfdt', 'packages.json');

describe('readPackageNotes', () => {
  it('treats a missing file as empty — most projects never annotate one', async () => {
    await expect(readPackageNotes(config)).resolves.toEqual({
      version: NOTES_FORMAT_VERSION,
      packages: {},
    });
  });

  it('refuses malformed JSON rather than silently dropping committed annotations', async () => {
    await fs.writeFile(notesFile(), '{ not json', 'utf8');
    await expect(readPackageNotes(config)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a file with no packages object', async () => {
    await fs.writeJson(notesFile(), { version: 1 });
    await expect(readPackageNotes(config)).rejects.toThrow(/missing a "packages" object/);
  });

  it('refuses a NEWER format version rather than guessing at it', async () => {
    // A newer sfdt may mean something different by the same keys; rewriting the
    // file would destroy that.
    await fs.writeJson(notesFile(), { version: NOTES_FORMAT_VERSION + 1, packages: {} });
    await expect(readPackageNotes(config)).rejects.toThrow(/Upgrade sfdt/);
  });
});

describe('validateNote', () => {
  it('rejects a latest version that cannot be compared', async () => {
    // The load-bearing check: an unparseable string stores fine and then
    // compares against nothing forever, so the package sits at "unknown" while
    // its owner believes it is being watched.
    expect(validateNote({ latestKnown: 'Winter 26' })).toHaveLength(1);
    expect(validateNote({ latestKnown: '3.10.0' })).toEqual([]);
    // An explicit clear is allowed.
    expect(validateNote({ latestKnown: '' })).toEqual([]);
  });

  it('rejects a URL that is not http(s)', () => {
    expect(validateNote({ url: 'javascript:alert(1)' })).toHaveLength(1);
    expect(validateNote({ url: 'https://example.com' })).toEqual([]);
  });
});

describe('writePackageNote', () => {
  it('writes the file with a format version', async () => {
    await writePackageNote(config, 'acme', { url: 'https://example.com' });
    const written = await fs.readJson(notesFile());

    expect(written.version).toBe(NOTES_FORMAT_VERSION);
    expect(written.packages.acme.url).toBe('https://example.com');
  });

  it('merges additively — an omitted field is left alone, not cleared', async () => {
    await writePackageNote(config, 'acme', { url: 'https://a', owner: 'Platform' });
    await writePackageNote(config, 'acme', { owner: 'Integrations' });
    const written = await fs.readJson(notesFile());

    expect(written.packages.acme).toMatchObject({ url: 'https://a', owner: 'Integrations' });
  });

  it('clears a field only on an explicit empty string', async () => {
    await writePackageNote(config, 'acme', { url: 'https://a' });
    await writePackageNote(config, 'acme', { url: '' });
    expect((await fs.readJson(notesFile())).packages.acme.url).toBeUndefined();
  });

  it('preserves keys written by a NEWER sfdt', async () => {
    // An older CLI must not strip a colleague's data just by editing a
    // neighbouring field.
    await fs.writeJson(notesFile(), {
      version: NOTES_FORMAT_VERSION,
      packages: { acme: { url: 'https://a', futureField: 'keep me' } },
    });
    await writePackageNote(config, 'acme', { owner: 'Platform' });

    expect((await fs.readJson(notesFile())).packages.acme.futureField).toBe('keep me');
  });

  it('stamps when the version was recorded, since an old note is weak evidence', async () => {
    await writePackageNote(config, 'acme', { latestKnown: '3.10.0' }, { now: '2026-08-22' });
    expect((await fs.readJson(notesFile())).packages.acme.latestCheckedAt).toBe('2026-08-22');
  });

  it('does not stamp when the version was not touched', async () => {
    await writePackageNote(config, 'acme', { owner: 'Platform' });
    expect((await fs.readJson(notesFile())).packages.acme.latestCheckedAt).toBeUndefined();
  });

  it('refuses an invalid version WITHOUT writing anything', async () => {
    await expect(writePackageNote(config, 'acme', { latestKnown: 'latest' })).rejects.toThrow(
      /not a version number/,
    );
    expect(await fs.pathExists(notesFile())).toBe(false);
  });

  it('leaves other packages untouched', async () => {
    await writePackageNote(config, 'acme', { owner: 'A' });
    await writePackageNote(config, 'zeta', { owner: 'B' });
    const written = await fs.readJson(notesFile());

    expect(Object.keys(written.packages).sort()).toEqual(['acme', 'zeta']);
  });
});

describe('listPackages', () => {
  it('queries Tooling and folds the repo annotations in', async () => {
    vi.mocked(query).mockResolvedValue([
      {
        SubscriberPackage: { Name: 'Acme', NamespacePrefix: 'acme' },
        SubscriberPackageVersion: { MajorVersion: 3, MinorVersion: 9 },
      },
    ]);
    await writePackageNote(config, 'acme', { latestKnown: '3.10.0' });

    const vm = await listPackages(config, 'prod');

    expect(query).toHaveBeenCalledWith('prod', expect.stringContaining('InstalledSubscriberPackage'), {
      tooling: true,
    });
    expect(vm.org).toBe('prod');
    expect(vm.rows[0].updateStatus).toBe('update-available');
  });

  it('propagates a refused query rather than reporting an empty org', async () => {
    vi.mocked(query).mockRejectedValue(new Error('INSUFFICIENT_ACCESS'));
    await expect(listPackages(config, 'prod')).rejects.toThrow('INSUFFICIENT_ACCESS');
  });
});

describe('comparePackages', () => {
  it('compares two orgs and names which is behind', async () => {
    vi.mocked(query).mockImplementation(async (org) => [
      {
        SubscriberPackage: { Name: 'Acme', NamespacePrefix: 'acme' },
        SubscriberPackageVersion: { MajorVersion: 3, MinorVersion: org === 'uat' ? 10 : 9 },
      },
    ]);

    const vm = await comparePackages('uat', 'prod');
    expect(vm.rows[0].verdict).toBe('source-ahead');
    expect(vm.rows[0].detail).toContain('prod is behind');
  });

  it('rejects when EITHER org fails — half a comparison is not a comparison', async () => {
    // Reporting one org's packages as "only in source" because the other query
    // failed would be a confidently wrong answer.
    vi.mocked(query).mockImplementation(async (org) => {
      if (org === 'prod') throw new Error('no auth for prod');
      return [];
    });

    await expect(comparePackages('uat', 'prod')).rejects.toThrow('no auth for prod');
  });
});
