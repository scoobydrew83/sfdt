import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs-extra';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  APEXGURU_DEFAULTS,
  checkApexGuruAccess,
  parseApexGuruReport,
  analyzeApexClass,
  findApexClasses,
  runApexGuruCheck,
  persistApexGuruSnapshot,
} from '../../src/lib/apexguru-runner.js';

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const sfOk = (obj) => ({ stdout: JSON.stringify(obj) });

// One representative ApexGuru report entry (shape from the org-side service:
// type + value + a properties[] array of { name, value } pairs).
const SAMPLE_REPORT = [
  {
    type: 'BestPractice',
    value: 'Avoid SOQL inside loops',
    properties: [{ name: 'line_number', value: '12' }],
  },
  {
    type: 'CodeInfo',
    value: 'Hot method detected',
    properties: [],
  },
];

let tmpDir;

beforeEach(async () => {
  vi.resetAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-apexguru-'));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

async function writeCls(name, content = 'public class X {}') {
  const file = path.join(tmpDir, name);
  await fs.outputFile(file, content);
  return file;
}

describe('checkApexGuruAccess', () => {
  it('reports available when validate returns Success', async () => {
    execa.mockResolvedValueOnce(sfOk({ status: 'Success' }));
    const r = await checkApexGuruAccess('dev');
    expect(r).toEqual({ available: true, reason: null });
    // validate endpoint hit through `sf api request rest`
    const argv = execa.mock.calls[0][1];
    expect(argv.slice(0, 3)).toEqual(['api', 'request', 'rest']);
    expect(argv[3]).toContain('/apexguru/validate');
    expect(argv).toContain('--target-org');
  });

  it('reports unavailable (not an error) when validate returns a non-Success status', async () => {
    execa.mockResolvedValueOnce(sfOk({ status: 'Failed' }));
    const r = await checkApexGuruAccess('dev');
    expect(r.available).toBe(false);
    expect(r.reason).toContain('not enabled');
  });

  it('reports unavailable with the structured Salesforce message when the request fails', async () => {
    const err = new Error('Command failed');
    err.stdout = JSON.stringify([{ message: 'The requested resource does not exist', errorCode: 'NOT_FOUND' }]);
    execa.mockRejectedValueOnce(err);
    const r = await checkApexGuruAccess('dev');
    expect(r.available).toBe(false);
    expect(r.reason).toContain('The requested resource does not exist');
  });

  it('reports unavailable when the sf CLI itself is missing', async () => {
    execa.mockRejectedValueOnce(new Error('spawn sf ENOENT'));
    const r = await checkApexGuruAccess('dev');
    expect(r.available).toBe(false);
    expect(r.reason).toContain('ENOENT');
  });
});

describe('parseApexGuruReport', () => {
  it('decodes a base64 report into normalized findings', () => {
    const findings = parseApexGuruReport(b64(SAMPLE_REPORT), '/p/A.cls');
    expect(findings).toEqual([
      { file: '/p/A.cls', type: 'BestPractice', line: 12, description: 'Avoid SOQL inside loops' },
      { file: '/p/A.cls', type: 'CodeInfo', line: null, description: 'Hot method detected' },
    ]);
  });

  it('returns [] for an empty or undecodable report', () => {
    expect(parseApexGuruReport(null, 'A.cls')).toEqual([]);
    expect(parseApexGuruReport('!!!not-base64-json!!!', 'A.cls')).toEqual([]);
    expect(parseApexGuruReport(b64({ nothing: true }), 'A.cls')).toEqual([]);
  });
});

describe('analyzeApexClass', () => {
  it('submits the class, polls until success, and returns findings', async () => {
    const file = await writeCls('Svc.cls');
    execa
      .mockResolvedValueOnce(sfOk({ requestId: 'req-1', status: 'new' })) // POST request
      .mockResolvedValueOnce(sfOk({ status: 'new' })) // poll 1
      .mockResolvedValueOnce(sfOk({ status: 'success', report: b64(SAMPLE_REPORT) })); // poll 2

    const findings = await analyzeApexClass('dev', file, { pollIntervalMs: 0 });
    expect(findings).toHaveLength(2);
    expect(findings[0].file).toBe(file);

    // The submit call carries the class content as base64 in a JSON --body.
    const submitArgv = execa.mock.calls[0][1];
    expect(submitArgv).toContain('--method');
    expect(submitArgv).toContain('POST');
    const body = JSON.parse(submitArgv[submitArgv.indexOf('--body') + 1]);
    expect(Buffer.from(body.classContent, 'base64').toString('utf8')).toContain('public class X');
  });

  it('throws when ApexGuru returns no requestId', async () => {
    const file = await writeCls('Svc.cls');
    execa.mockResolvedValueOnce(sfOk({ status: 'unauthorized' }));
    await expect(analyzeApexClass('dev', file, { pollIntervalMs: 0 })).rejects.toThrow(/requestId/);
  });

  it('throws when the analysis reports failed', async () => {
    const file = await writeCls('Svc.cls');
    execa
      .mockResolvedValueOnce(sfOk({ requestId: 'req-1' }))
      .mockResolvedValueOnce(sfOk({ status: 'failed' }));
    await expect(analyzeApexClass('dev', file, { pollIntervalMs: 0 })).rejects.toThrow(/failed/);
  });

  it('throws when polling exceeds the timeout', async () => {
    const file = await writeCls('Svc.cls');
    execa.mockResolvedValueOnce(sfOk({ requestId: 'req-1' }));
    execa.mockResolvedValue(sfOk({ status: 'new' })); // every poll stays pending
    await expect(
      analyzeApexClass('dev', file, { pollIntervalMs: 0, pollTimeoutMs: 0 }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('findApexClasses', () => {
  it('finds non-test classes under the default source path, largest first', async () => {
    const src = path.join(tmpDir, 'force-app/main/default/classes');
    await fs.outputFile(path.join(src, 'Big.cls'), 'x'.repeat(500));
    await fs.outputFile(path.join(src, 'Small.cls'), 'x'.repeat(10));
    await fs.outputFile(path.join(src, 'BigTest.cls'), 'x'.repeat(900));
    await fs.outputFile(path.join(src, 'Big_Test.cls'), 'x'.repeat(900));
    await fs.outputFile(path.join(src, 'BigTests.cls'), 'x'.repeat(900));

    const files = await findApexClasses({ _projectRoot: tmpDir });
    expect(files.map((f) => path.basename(f))).toEqual(['Big.cls', 'Small.cls']);
  });

  it('honors config.defaultSourcePath', async () => {
    await fs.outputFile(path.join(tmpDir, 'src/pkg/classes/A.cls'), 'x');
    const files = await findApexClasses({ _projectRoot: tmpDir, defaultSourcePath: 'src/pkg' });
    expect(files.map((f) => path.basename(f))).toEqual(['A.cls']);
  });
});

describe('runApexGuruCheck', () => {
  const config = () => ({ _projectRoot: tmpDir });

  it('skips (never errors) when no org is specified', async () => {
    const r = await runApexGuruCheck('', config());
    expect(r.status).toBe('skipped');
    expect(r.summary).toContain('No target org');
    expect(execa).not.toHaveBeenCalled();
  });

  it('skips with the gate reason when ApexGuru is unavailable in the org', async () => {
    const err = new Error('boom');
    err.stdout = JSON.stringify([{ message: 'NOT_FOUND', errorCode: 'NOT_FOUND' }]);
    execa.mockRejectedValueOnce(err);
    const r = await runApexGuruCheck('dev', config());
    expect(r.status).toBe('skipped');
    expect(r.summary).toContain('license/edition-gated');
    expect(r.summary).toContain('NOT_FOUND');
  });

  it('skips when the org has ApexGuru but the project has no Apex classes', async () => {
    execa.mockResolvedValueOnce(sfOk({ status: 'Success' }));
    const r = await runApexGuruCheck('dev', config(), { files: [] });
    expect(r.status).toBe('skipped');
    expect(r.summary).toContain('No Apex classes');
  });

  it('returns ok on a clean analysis', async () => {
    const file = await writeCls('Svc.cls');
    execa
      .mockResolvedValueOnce(sfOk({ status: 'Success' })) // validate
      .mockResolvedValueOnce(sfOk({ requestId: 'req-1' })) // submit
      .mockResolvedValueOnce(sfOk({ status: 'success', report: b64([]) })); // poll
    const r = await runApexGuruCheck('dev', config(), { files: [file], pollIntervalMs: 0 });
    expect(r.status).toBe('ok');
    expect(r.findings).toEqual([]);
    expect(r.summary).toContain('no issues');
  });

  it('returns warn with findings when ApexGuru reports insights', async () => {
    const file = await writeCls('Svc.cls');
    execa
      .mockResolvedValueOnce(sfOk({ status: 'Success' }))
      .mockResolvedValueOnce(sfOk({ requestId: 'req-1' }))
      .mockResolvedValueOnce(sfOk({ status: 'success', report: b64(SAMPLE_REPORT) }));
    const r = await runApexGuruCheck('dev', config(), { files: [file], pollIntervalMs: 0 });
    expect(r.status).toBe('warn');
    expect(r.findings).toHaveLength(2);
    expect(r.summary).toContain('2 insight(s)');
  });

  it('degrades to warn (never error) when every per-class analysis fails', async () => {
    const file = await writeCls('Svc.cls');
    execa
      .mockResolvedValueOnce(sfOk({ status: 'Success' })) // validate
      .mockResolvedValueOnce(sfOk({ requestId: 'req-1' })) // submit
      .mockResolvedValueOnce(sfOk({ status: 'failed' })); // poll fails
    const r = await runApexGuruCheck('dev', config(), { files: [file], pollIntervalMs: 0 });
    expect(r.status).toBe('warn');
    expect(r.summary).toContain('could not be completed');
    expect(r.degraded).toHaveLength(1);
  });

  it('caps the analysis at maxClasses, largest classes first', async () => {
    const a = await writeCls('A.cls', 'x'.repeat(100));
    const c = await writeCls('C.cls', 'x'.repeat(50));
    execa.mockResolvedValueOnce(sfOk({ status: 'Success' })); // validate
    // one submit + one poll for the single selected class
    execa.mockResolvedValueOnce(sfOk({ requestId: 'req-1' }));
    execa.mockResolvedValueOnce(sfOk({ status: 'success', report: b64([]) }));
    const r = await runApexGuruCheck('dev', config(), { files: [a, c], maxClasses: 1, pollIntervalMs: 0 });
    expect(r.status).toBe('ok');
    // validate + submit + poll = 3 calls; the second class was never submitted
    expect(execa).toHaveBeenCalledTimes(3);
  });

  it('never surfaces an error status, even on unexpected failures', async () => {
    execa.mockResolvedValueOnce(sfOk({ status: 'Success' }));
    // Force an unexpected throw inside the discovery path.
    const r = await runApexGuruCheck('dev', { _projectRoot: null, defaultSourcePath: null }, { files: null });
    expect(['ok', 'warn', 'skipped']).toContain(r.status);
    expect(r.status).not.toBe('error');
  });
});

describe('persistApexGuruSnapshot', () => {
  it('writes the raw snapshot, an archive copy, and returns the latest path', async () => {
    const logDir = path.join(tmpDir, 'logs');
    const result = {
      id: 'apexguru',
      status: 'skipped',
      summary: 'No target org',
      findings: [],
      org: null,
      timestamp: new Date().toISOString(),
      durationMs: 1,
    };
    const latest = await persistApexGuruSnapshot({ logDir, _projectRoot: tmpDir }, result);
    expect(latest).toBe(path.join(logDir, 'apexguru-latest.json'));
    // Raw on disk — no {status, result} stdout envelope.
    const onDisk = await fs.readJson(latest);
    expect(onDisk).toEqual(result);
    const archives = await fs.readdir(path.join(logDir, 'apexguru-results'));
    expect(archives.filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('is best-effort: returns null instead of throwing when the log dir is unwritable', async () => {
    const blocker = path.join(tmpDir, 'not-a-dir');
    await fs.outputFile(blocker, 'file, not dir');
    const result = { id: 'apexguru', status: 'ok', summary: '', findings: [], timestamp: new Date().toISOString() };
    const latest = await persistApexGuruSnapshot({ logDir: path.join(blocker, 'logs') }, result);
    expect(latest).toBeNull();
  });
});

describe('APEXGURU_DEFAULTS', () => {
  it('exposes the tunable defaults', () => {
    expect(APEXGURU_DEFAULTS.maxClasses).toBeGreaterThan(0);
    expect(APEXGURU_DEFAULTS.pollTimeoutMs).toBeGreaterThan(0);
  });
});
