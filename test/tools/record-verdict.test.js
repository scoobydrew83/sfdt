// record-verdict writes each row twice: full text into the private .work
// mirror, redacted into the tracked .harness one that ships in a public repo.
// These tests pin that split — a regression here leaks verbatim criterion text
// into the public repo, or silently conjures a .work/ directory on a machine
// that has no such checkout.

import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { fileURLToPath } from 'url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tools',
  'record-verdict.mjs',
);

const BLOCK = `VERDICT: PASS
PHASE: telemetry-split
CRITERIA:
  - [PASS] secret sauce criterion text
  - [FAIL] another criterion
`;

async function run(dir, { withWorkDir = true } = {}) {
  const verdictFile = path.join(dir, 'VERDICT.md');
  await fs.writeFile(verdictFile, BLOCK);
  const publicPath = path.join(dir, 'harness', 'telemetry.jsonl');
  const privatePath = path.join(dir, 'work', 'telemetry.jsonl');
  if (withWorkDir) await fs.ensureDir(path.dirname(privatePath));

  await execa('node', [
    SCRIPT,
    '--file', verdictFile,
    '--log-dir', path.join(dir, 'logs'),
    '--telemetry', publicPath,
    '--private-telemetry', privatePath,
  ]);

  const read = async (p) =>
    (await fs.pathExists(p))
      ? (await fs.readFile(p, 'utf8')).trim().split('\n').map((l) => JSON.parse(l))
      : null;
  return { publicRows: await read(publicPath), privateRows: await read(privatePath), privatePath };
}

describe('record-verdict telemetry split', () => {
  it('keeps verbatim criterion text out of the public mirror', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-verdict-'));
    try {
      const { publicRows } = await run(dir);
      expect(publicRows).toHaveLength(1);
      expect(publicRows[0]).toMatchObject({ type: 'verdict', status: 'pass' });
      expect(publicRows[0].summary).toMatchObject({ phase: 'telemetry-split', criteriaCount: 2 });
      expect(publicRows[0].summary.criteria).toBeUndefined();
      expect(JSON.stringify(publicRows[0])).not.toContain('secret sauce');
    } finally {
      await fs.remove(dir);
    }
  });

  it('keeps the full criterion text in the private mirror', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-verdict-'));
    try {
      const { privateRows } = await run(dir);
      expect(privateRows).toHaveLength(1);
      expect(privateRows[0].summary.criteria).toEqual([
        { status: 'PASS', text: 'secret sauce criterion text' },
        { status: 'FAIL', text: 'another criterion' },
      ]);
    } finally {
      await fs.remove(dir);
    }
  });

  it('does not create the private directory when it is absent', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-verdict-'));
    try {
      const { publicRows, privatePath } = await run(dir, { withWorkDir: false });
      expect(await fs.pathExists(path.dirname(privatePath))).toBe(false);
      // the public mirror still gets its row — the gate is private-only
      expect(publicRows).toHaveLength(1);
    } finally {
      await fs.remove(dir);
    }
  });
});
