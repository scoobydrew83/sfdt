import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('fs-extra', () => ({
  default: {
    mkdtemp: vi.fn(),
    writeFile: vi.fn(),
    remove: vi.fn(),
    outputFile: vi.fn(),
  },
}));
vi.mock('../../src/lib/org-query.js', () => ({
  query: vi.fn(),
  safeParse: (text) => {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  },
}));

import { execa } from 'execa';
import fs from 'fs-extra';
import { query } from '../../src/lib/org-query.js';
import {
  soqlQuote,
  toApiDateTime,
  sfError,
  getDefaultUsername,
  resolveUserId,
  ensureDebugLevel,
  startTrace,
  listTraceFlags,
  stopTrace,
  mapLogRecord,
  listLogs,
  getLog,
  watchLogs,
  runAnonymous,
  DEFAULT_DEBUG_LEVEL,
  MAX_TRACE_MINUTES,
} from '../../src/lib/apex-runner.js';

const envelope = (result) => ({ stdout: JSON.stringify({ status: 0, result }) });

beforeEach(() => {
  vi.resetAllMocks();
  fs.remove.mockResolvedValue(undefined);
});

describe('soqlQuote', () => {
  it('escapes single quotes and backslashes', () => {
    expect(soqlQuote("o'brien")).toBe("o\\'brien");
    expect(soqlQuote('a\\b')).toBe('a\\\\b');
  });
});

describe('toApiDateTime', () => {
  it('strips milliseconds from the ISO string', () => {
    expect(toApiDateTime('2026-07-29T10:00:00.123Z')).toBe('2026-07-29T10:00:00Z');
  });
});

describe('sfError', () => {
  it('degrades to an actionable hint when the apex plugin is missing', () => {
    const e = sfError({ stderr: 'Error: apex is not a sf command.', message: 'boom' });
    expect(e.code).toBe('SF_APEX_PLUGIN_MISSING');
    expect(e.message).toContain('sf plugins install @salesforce/plugin-apex');
  });
  it('prefers the structured JSON message from stdout', () => {
    const e = sfError({ stdout: JSON.stringify({ status: 1, message: 'INVALID_SESSION_ID' }), message: 'Command failed' });
    expect(e.message).toBe('INVALID_SESSION_ID');
  });
  it('passes unknown errors through untouched', () => {
    const raw = new Error('spawn sf ENOENT');
    expect(sfError(raw)).toBe(raw);
  });
});

describe('getDefaultUsername', () => {
  it('reads the username from sf org display', async () => {
    execa.mockResolvedValueOnce(envelope({ username: 'admin@example.com' }));
    expect(await getDefaultUsername('dev')).toBe('admin@example.com');
    expect(execa).toHaveBeenCalledWith('sf', ['org', 'display', '--target-org', 'dev', '--json']);
  });
  it('throws when no username comes back', async () => {
    execa.mockResolvedValueOnce(envelope({}));
    await expect(getDefaultUsername('dev')).rejects.toThrow(/Could not resolve/);
  });
});

describe('resolveUserId', () => {
  it('resolves a username to its Id', async () => {
    query.mockResolvedValueOnce([{ Id: '005xx0000012345', Username: 'admin@example.com' }]);
    expect(await resolveUserId('dev', 'admin@example.com')).toBe('005xx0000012345');
    expect(query.mock.calls[0][1]).toContain("Username = 'admin@example.com'");
  });
  it('throws for an unknown user', async () => {
    query.mockResolvedValueOnce([]);
    await expect(resolveUserId('dev', 'ghost@example.com')).rejects.toThrow(/not found/);
  });
});

describe('ensureDebugLevel', () => {
  it('returns an existing level without creating', async () => {
    query.mockResolvedValueOnce([{ Id: '7dl000000000001' }]);
    expect(await ensureDebugLevel('dev', 'SFDC_DevConsole')).toEqual({ id: '7dl000000000001', created: false });
    expect(execa).not.toHaveBeenCalled();
  });
  it('creates the sfdt-owned default level on demand', async () => {
    query.mockResolvedValueOnce([]);
    execa.mockResolvedValueOnce(envelope({ id: '7dl000000000002' }));
    expect(await ensureDebugLevel('dev')).toEqual({ id: '7dl000000000002', created: true });
    const args = execa.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['data', 'create', 'record', '--use-tooling-api', '--sobject', 'DebugLevel']));
    const values = args[args.indexOf('--values') + 1];
    expect(values).toContain(`DeveloperName=${DEFAULT_DEBUG_LEVEL}`);
    expect(values).toContain('ApexCode=DEBUG');
  });
  it('refuses to invent a user-named level that does not exist', async () => {
    query.mockResolvedValueOnce([]);
    await expect(ensureDebugLevel('dev', 'MyLevel')).rejects.toThrow(/"MyLevel" not found/);
    expect(execa).not.toHaveBeenCalled();
  });
});

describe('startTrace', () => {
  beforeEach(() => {
    // getDefaultUsername → execa; resolveUserId + ensureDebugLevel → query
    query
      .mockResolvedValueOnce([{ Id: '005xx0000012345' }]) // user
      .mockResolvedValueOnce([{ Id: '7dl000000000001' }]); // debug level
  });

  it('creates a USER_DEBUG trace flag with the requested window', async () => {
    execa.mockResolvedValueOnce(envelope({ id: '7tf000000000001' }));
    const out = await startTrace('dev', { user: 'admin@example.com', durationMinutes: 30 });
    expect(out).toMatchObject({
      org: 'dev',
      user: 'admin@example.com',
      userId: '005xx0000012345',
      traceFlagId: '7tf000000000001',
      debugLevel: DEFAULT_DEBUG_LEVEL,
      durationMinutes: 30,
    });
    const args = execa.mock.calls[0][1];
    expect(args).toEqual(expect.arrayContaining(['--sobject', 'TraceFlag', '--target-org', 'dev']));
    const values = args[args.indexOf('--values') + 1];
    expect(values).toContain('TracedEntityId=005xx0000012345');
    expect(values).toContain('LogType=USER_DEBUG');
    expect(values).toContain('DebugLevelId=7dl000000000001');
    expect(Date.parse(out.expirationDate) - Date.parse(out.startDate)).toBe(30 * 60_000);
  });

  it('caps the window at 24 hours', async () => {
    execa.mockResolvedValueOnce(envelope({ id: '7tf000000000001' }));
    const out = await startTrace('dev', { user: 'admin@example.com', durationMinutes: 99999 });
    expect(out.durationMinutes).toBe(MAX_TRACE_MINUTES);
  });

  it('resolves the authenticated user when none is given', async () => {
    execa
      .mockResolvedValueOnce(envelope({ username: 'default@example.com' })) // org display
      .mockResolvedValueOnce(envelope({ id: '7tf000000000009' })); // create record
    const out = await startTrace('dev');
    expect(out.user).toBe('default@example.com');
  });
});

describe('listTraceFlags', () => {
  it('maps records and computes active state', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    query.mockResolvedValueOnce([
      { Id: '7tf1', TracedEntityId: '005a', LogType: 'USER_DEBUG', StartDate: 's', ExpirationDate: future, DebugLevel: { DeveloperName: 'SFDT_Trace' } },
      { Id: '7tf2', TracedEntityId: '005b', LogType: 'USER_DEBUG', StartDate: 's', ExpirationDate: '2020-01-01T00:00:00Z', DebugLevel: null },
    ]);
    const out = await listTraceFlags('dev');
    expect(out.traceFlags[0]).toMatchObject({ id: '7tf1', active: true, debugLevel: 'SFDT_Trace' });
    expect(out.traceFlags[1]).toMatchObject({ id: '7tf2', active: false, debugLevel: null });
    expect(query.mock.calls[0][2]).toEqual({ tooling: true });
  });
});

describe('stopTrace', () => {
  it('deletes the resolved user\'s flags', async () => {
    execa.mockResolvedValueOnce(envelope({ username: 'admin@example.com' })); // org display
    query
      .mockResolvedValueOnce([{ Id: '005xx0000012345' }]) // user id
      .mockResolvedValueOnce([{ Id: '7tf1' }, { Id: '7tf2' }]); // trace flags
    execa
      .mockResolvedValueOnce(envelope({ id: '7tf1' }))
      .mockResolvedValueOnce(envelope({ id: '7tf2' }));
    const out = await stopTrace('dev');
    expect(out).toMatchObject({ deleted: 2, ids: ['7tf1', '7tf2'], user: 'admin@example.com' });
    expect(query.mock.calls[1][1]).toContain("TracedEntityId = '005xx0000012345'");
    const deleteCall = execa.mock.calls[1][1];
    expect(deleteCall).toEqual(expect.arrayContaining(['data', 'delete', 'record', '--record-id', '7tf1']));
  });

  it('--all deletes every USER_DEBUG flag without resolving a user', async () => {
    query.mockResolvedValueOnce([{ Id: '7tf1' }]);
    execa.mockResolvedValueOnce(envelope({ id: '7tf1' }));
    const out = await stopTrace('dev', { all: true });
    expect(out).toMatchObject({ deleted: 1, user: null });
    expect(query.mock.calls[0][1]).not.toContain('TracedEntityId');
  });
});

describe('listLogs', () => {
  const raw = [
    { Id: 'L1', StartTime: '2026-07-29T10:00:00Z', LogUser: { Name: 'Ada' }, Operation: 'Api', LogLength: 10 },
    { Id: 'L2', StartTime: '2026-07-29T12:00:00Z', LogUser: { Name: 'Bob' }, Operation: 'ExecuteAnonymous', LogLength: 20 },
    { Id: 'L3', StartTime: '2026-07-29T11:00:00Z', LogUser: { Name: 'Ada' }, Operation: 'Api', LogLength: 30 },
  ];

  it('sorts newest first and applies the limit', async () => {
    execa.mockResolvedValueOnce(envelope(raw));
    const out = await listLogs('dev', { limit: 2 });
    expect(out.logs.map((l) => l.id)).toEqual(['L2', 'L3']);
    expect(out.total).toBe(3);
  });

  it('filters by user before limiting', async () => {
    execa.mockResolvedValueOnce(envelope(raw));
    const out = await listLogs('dev', { user: 'Ada' });
    expect(out.logs.map((l) => l.id)).toEqual(['L3', 'L1']);
  });

  it('returns an empty list when the org has no logs', async () => {
    execa.mockResolvedValueOnce(envelope(null));
    const out = await listLogs('dev');
    expect(out).toMatchObject({ total: 0, logs: [] });
  });
});

describe('mapLogRecord', () => {
  it('maps the raw ApexLog shape to the compact report shape', () => {
    expect(
      mapLogRecord({ Id: 'L1', LogUser: { Name: 'Ada' }, Operation: 'Api', Application: 'Browser', Status: 'Success', Request: 'Api', DurationMilliseconds: 5, LogLength: 10, StartTime: 't' }),
    ).toEqual({ id: 'L1', user: 'Ada', operation: 'Api', application: 'Browser', status: 'Success', request: 'Api', durationMs: 5, lengthBytes: 10, startTime: 't' });
  });
});

describe('getLog', () => {
  it('handles the array result shape', async () => {
    execa.mockResolvedValueOnce(envelope([{ log: 'BODY' }]));
    const out = await getLog('dev', 'L1');
    expect(out).toMatchObject({ id: 'L1', log: 'BODY', lengthBytes: 4, outputFile: null });
    expect(execa).toHaveBeenCalledWith('sf', ['apex', 'get', 'log', '--log-id', 'L1', '--target-org', 'dev', '--json']);
  });
  it('handles the object result shape and writes --output raw, owner-only', async () => {
    execa.mockResolvedValueOnce(envelope({ log: 'BODY' }));
    const out = await getLog('dev', 'L1', { outputFile: '/tmp/x.log' });
    expect(fs.outputFile).toHaveBeenCalledWith('/tmp/x.log', 'BODY', { mode: 0o600 });
    expect(out.outputFile).toBe('/tmp/x.log');
  });
  it('requires a log id', async () => {
    await expect(getLog('dev', '')).rejects.toThrow(/required/);
  });
});

describe('watchLogs', () => {
  const meta = (id, t) => ({ id, startTime: t });

  function makeDeps({ polls, bodies = {} }) {
    let clock = 0;
    const list = vi.fn(async () => ({ logs: polls.shift() ?? [] }));
    const get = vi.fn(async (_org, id) => ({ log: bodies[id] ?? `body-${id}` }));
    const sleep = vi.fn(async (ms) => {
      clock += ms;
    });
    const now = () => clock;
    return { list, get, sleep, now };
  }

  it('streams only logs newer than the watch start, oldest-first', async () => {
    const deps = makeDeps({
      polls: [
        [meta('A', '1')], // seed
        [meta('C', '3'), meta('B', '2'), meta('A', '1')],
        [], // subsequent polls until duration elapses
        [],
      ],
    });
    const seen = [];
    const out = await watchLogs(
      'dev',
      { intervalMs: 1000, durationMs: 3500, onLog: (e) => seen.push(e) },
      deps,
    );
    expect(seen.map((e) => e.meta.id)).toEqual(['B', 'C']);
    expect(seen[0].body).toBe('body-B');
    expect(out.newLogs).toBe(2);
  });

  it('stops at maxLogs', async () => {
    const deps = makeDeps({
      polls: [[], [meta('B', '2'), meta('A', '1')], [meta('C', '3')]],
    });
    const out = await watchLogs('dev', { intervalMs: 1000, durationMs: 0, maxLogs: 2 }, deps);
    expect(out.newLogs).toBe(2);
  });

  it('honours the duration bound without fetching bodies when fetchBody=false', async () => {
    const deps = makeDeps({ polls: [[], [meta('B', '2')]] });
    const out = await watchLogs('dev', { intervalMs: 1000, durationMs: 2000, fetchBody: false }, deps);
    expect(deps.get).not.toHaveBeenCalled();
    expect(out.watchedMs).toBeGreaterThanOrEqual(2000);
  });
});

describe('runAnonymous', () => {
  it('returns diagnostics for a successful run from a file', async () => {
    execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ status: 0, result: { success: true, compiled: true, logs: 'LOG' } }),
    });
    const out = await runAnonymous('dev', { file: '/p/script.apex' });
    expect(out).toMatchObject({ success: true, compiled: true, logs: 'LOG', file: '/p/script.apex' });
    expect(execa).toHaveBeenCalledWith(
      'sf',
      ['apex', 'run', '--file', '/p/script.apex', '--target-org', 'dev', '--json'],
      { reject: false },
    );
  });

  it('surfaces compile failures without throwing', async () => {
    execa.mockResolvedValueOnce({
      exitCode: 1,
      stdout: JSON.stringify({
        status: 1,
        result: { success: false, compiled: false, compileProblem: 'Unexpected token', line: 1, column: 5 },
      }),
    });
    const out = await runAnonymous('dev', { file: '/p/bad.apex' });
    expect(out).toMatchObject({ success: false, compiled: false, compileProblem: 'Unexpected token', line: 1, column: 5 });
  });

  it('writes inline code to a temp file and cleans it up', async () => {
    fs.mkdtemp.mockResolvedValueOnce('/tmp/sfdt-apex-x');
    execa.mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ status: 0, result: { success: true, compiled: true } }),
    });
    const out = await runAnonymous('dev', { code: 'System.debug(1);' });
    expect(fs.writeFile).toHaveBeenCalledWith('/tmp/sfdt-apex-x/anonymous.apex', 'System.debug(1);');
    expect(execa.mock.calls[0][1]).toContain('/tmp/sfdt-apex-x/anonymous.apex');
    expect(fs.remove).toHaveBeenCalledWith('/tmp/sfdt-apex-x');
    expect(out.file).toBeNull();
  });

  it('throws a transport error when stdout is not the sf envelope', async () => {
    execa.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'apex is not a sf command' });
    await expect(runAnonymous('dev', { file: '/p/x.apex' })).rejects.toThrow(/plugin-apex/);
  });

  it('requires code or a file', async () => {
    await expect(runAnonymous('dev', {})).rejects.toThrow(/Provide Apex code/);
  });
});
