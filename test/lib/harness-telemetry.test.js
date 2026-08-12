import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import {
  mirrorTelemetry,
  redactForPublic,
  mirrorHarnessRow,
} from '../../src/lib/harness-telemetry.js';

describe('mirrorTelemetry', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-telemetry-'));
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  it('does nothing without a path — shipped code must not write by default', () => {
    expect(mirrorTelemetry({ type: 'agent-fix' }, undefined)).toBe(false);
    expect(mirrorTelemetry({ type: 'agent-fix' }, '')).toBe(false);
    expect(mirrorTelemetry({ type: 'agent-fix' }, null)).toBe(false);
  });

  it('appends one JSON line per row, creating missing parent dirs', () => {
    const file = path.join(dir, '.harness', 'telemetry.jsonl');

    expect(mirrorTelemetry({ type: 'verdict', status: 'fail' }, file)).toBe(true);
    expect(mirrorTelemetry({ type: 'agent-fix', status: 'pass' }, file)).toBe(true);

    const rows = fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toEqual([
      { type: 'verdict', status: 'fail' },
      { type: 'agent-fix', status: 'pass' },
    ]);
  });

  it('never throws when the destination is unwritable — telemetry cannot break the measured', () => {
    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'not a directory');
    // parent of the target is a regular file, so mkdir/append must fail
    expect(mirrorTelemetry({ type: 'verdict' }, path.join(file, 'telemetry.jsonl'))).toBe(false);
  });
});

describe('redactForPublic', () => {
  it('replaces verbatim criterion text with a count', () => {
    const row = {
      type: 'verdict',
      status: 'pass',
      summary: {
        phase: 'p1',
        verdict: 'PASS',
        criteria: [
          { status: 'PASS', text: 'secret sauce criterion' },
          { status: 'FAIL', text: 'another one' },
        ],
      },
    };
    const out = redactForPublic(row);
    expect(out.summary.criteriaCount).toBe(2);
    expect(out.summary.criteria).toBeUndefined();
    expect(out.summary.phase).toBe('p1');
    expect(JSON.stringify(out)).not.toContain('secret sauce');
    // input is not mutated — the private mirror still needs the full row
    expect(row.summary.criteria).toHaveLength(2);
  });

  it('passes through rows that carry no criteria', () => {
    const escalation = { type: 'escalation', summary: { phase: 'p1', category: 'flaky' } };
    expect(redactForPublic(escalation)).toBe(escalation);
    expect(redactForPublic({ type: 'agent-fix' })).toEqual({ type: 'agent-fix' });
  });
});

describe('mirrorHarnessRow', () => {
  let dir;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-telemetry-split-'));
  });
  afterEach(async () => {
    await fs.remove(dir);
  });

  const row = () => ({
    type: 'verdict',
    status: 'pass',
    summary: { phase: 'p1', criteria: [{ status: 'PASS', text: 'secret sauce criterion' }] },
  });
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8').trim());

  it('keeps full text private and writes a redacted row publicly', () => {
    const pub = path.join(dir, 'harness', 'telemetry.jsonl');
    const priv = path.join(dir, 'work', 'telemetry.jsonl');
    fs.ensureDirSync(path.dirname(priv));

    expect(mirrorHarnessRow(row(), { telemetryPath: pub, privateTelemetryPath: priv })).toEqual({
      public: true,
      private: true,
    });
    expect(read(priv).summary.criteria).toEqual([
      { status: 'PASS', text: 'secret sauce criterion' },
    ]);
    expect(read(pub).summary.criteriaCount).toBe(1);
    expect(fs.readFileSync(pub, 'utf8')).not.toContain('secret sauce');
  });

  it('does not create the private directory when it is absent', () => {
    const pub = path.join(dir, 'harness', 'telemetry.jsonl');
    const priv = path.join(dir, 'no-such-checkout', 'telemetry.jsonl');

    const res = mirrorHarnessRow(row(), { telemetryPath: pub, privateTelemetryPath: priv });
    expect(res).toEqual({ public: true, private: false });
    expect(fs.existsSync(path.dirname(priv))).toBe(false);
    expect(read(pub).summary.criteriaCount).toBe(1);
  });

  it('still redacts publicly when no private path is configured', () => {
    const pub = path.join(dir, 'harness', 'telemetry.jsonl');
    expect(mirrorHarnessRow(row(), { telemetryPath: pub })).toEqual({
      public: true,
      private: false,
    });
    expect(read(pub).summary.criteria).toBeUndefined();
  });
});
