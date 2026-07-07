/**
 * Smoke tests for the @sfdt/host native messaging host.
 *
 * Exercises the host via its `--smoke=<json>` mode so we don't have to
 * simulate Chrome's stdio framing in-process. Each invocation spawns the
 * host as a child, feeds it one request, and parses the framed response off
 * stdout.
 *
 * These tests are isolated from the rest of the suite: they spawn a real
 * Node process and exercise the actual entrypoint at host/src/index.js.
 */

import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.resolve(__dirname, '..', 'host', 'src', 'index.js');

// Env that guarantees the host resolves NO project: empty SFDT_PROJECT_ROOT and
// an XDG_CONFIG_HOME pointed at a dir without a sfdt-host.json. Keeps the
// "no project configured" assertions deterministic regardless of the dev machine.
const NO_PROJECT_ENV = {
  SFDT_PROJECT_ROOT: '',
  XDG_CONFIG_HOME: path.join(os.tmpdir(), 'sfdt-host-test-noconfig'),
};

async function smoke(payload, env) {
  const result = await execa('node', [HOST_ENTRY, `--smoke=${JSON.stringify(payload)}`], {
    reject: false,
    encoding: 'buffer',
    timeout: 10_000,
    env,
  });
  // execa returns a Uint8Array (not a Node Buffer) under `encoding: 'buffer'`,
  // so wrap it before using Buffer-specific methods.
  const stdout = Buffer.from(result.stdout);
  if (stdout.length < 4) {
    throw new Error(
      `Host produced no framed output (exitCode=${result.exitCode}, stderr=${result.stderr?.toString?.() ?? ''})`,
    );
  }
  const length = stdout.readUInt32LE(0);
  const body = stdout.subarray(4, 4 + length);
  return JSON.parse(body.toString('utf8'));
}

describe('@sfdt/host — smoke mode', () => {
  it('responds to ping with pong + native transport', async () => {
    const response = await smoke({ requestId: 'r1', kind: 'ping' });
    expect(response.ok).toBe(true);
    expect(response.requestId).toBe('r1');
    expect(response.data.pong).toBe(true);
    expect(response.data.transport).toBe('native');
  });

  it('returns NOT_FOUND for read-only kinds when no project is configured', async () => {
    const response = await smoke({ requestId: 'r2', kind: 'drift', component: 'Account' }, NO_PROJECT_ENV);
    expect(response.ok).toBe(false);
    expect(response.code).toBe('NOT_FOUND');
    expect(response.requestId).toBe('r2');
  });

  it('returns NOT_FOUND for org-health when no project is configured', async () => {
    const response = await smoke({ requestId: 'r2b', kind: 'org-health' }, NO_PROJECT_ENV);
    expect(response.ok).toBe(false);
    expect(response.code).toBe('NOT_FOUND');
    expect(response.requestId).toBe('r2b');
  });

  it('runs quality in-process without a project (flow-core)', async () => {
    const flowXml = JSON.stringify({ label: 'My Flow', processType: 'Flow' });
    const response = await smoke({ requestId: 'r2c', kind: 'quality', flowXml }, NO_PROJECT_ENV);
    expect(response.ok).toBe(true);
    expect(typeof response.data.overallScore).toBe('number');
    expect(response.data).toHaveProperty('issueFamilyCount');
  });

  it('keeps mutating kinds (deploy) bridge-only with NOT_IMPLEMENTED', async () => {
    const response = await smoke({ requestId: 'r2d', kind: 'deploy', flowApiName: 'My_Flow' }, NO_PROJECT_ENV);
    expect(response.ok).toBe(false);
    expect(response.code).toBe('NOT_IMPLEMENTED');
  });

  it('rejects an invalid SfdtRequest with REQUEST_INVALID', async () => {
    const response = await smoke({ requestId: 'r3', kind: 'compare' /* missing left/right */ });
    expect(response.ok).toBe(false);
    expect(response.code).toBe('REQUEST_INVALID');
    expect(response.requestId).toBe('r3');
  });

  it('rejects unknown kinds with REQUEST_INVALID', async () => {
    const response = await smoke({ requestId: 'r4', kind: 'totallymadeup' });
    expect(response.ok).toBe(false);
    expect(response.code).toBe('REQUEST_INVALID');
  });

  it('emits the framed response with the documented 4-byte LE length header', async () => {
    const result = await execa(
      'node',
      [HOST_ENTRY, '--smoke=' + JSON.stringify({ requestId: 'r5', kind: 'ping' })],
      { reject: false, encoding: 'buffer', timeout: 10_000 },
    );
    const stdout = Buffer.from(result.stdout);
    const length = stdout.readUInt32LE(0);
    expect(length).toBeGreaterThan(0);
    expect(stdout.length).toBe(4 + length);
  });
});
