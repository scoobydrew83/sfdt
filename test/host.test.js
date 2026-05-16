import { describe, it, expect } from 'vitest';
import { execa } from 'execa';
import path from 'path';
import { fileURLToPath } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.resolve(__dirname, '..', 'host', 'src', 'index.js');
async function smoke(payload) {
  const result = await execa('node', [HOST_ENTRY, `--smoke=${JSON.stringify(payload)}`], {
    reject: false,
    encoding: 'buffer',
    timeout: 10_000,
  });
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
  it('returns NOT_IMPLEMENTED for kinds without a handler yet', async () => {
    const response = await smoke({ requestId: 'r2', kind: 'drift', component: 'Account' });
    expect(response.ok).toBe(false);
    expect(response.code).toBe('NOT_IMPLEMENTED');
    expect(response.requestId).toBe('r2');
  });
  it('rejects an invalid SfdtRequest with REQUEST_INVALID', async () => {
    const response = await smoke({ requestId: 'r3', kind: 'compare'  });
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
