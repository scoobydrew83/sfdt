import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { mirrorTelemetry } from '../../src/lib/harness-telemetry.js';

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
