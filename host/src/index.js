#!/usr/bin/env node
import { execa } from 'execa';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
let _contract = null;
async function loadContract() {
  if (_contract) return _contract;
  try {
    _contract = await import('@sfdt/flow-core/bridge-contract');
  } catch (err) {
    throw new Error(
      'Could not load @sfdt/flow-core. Did you run `npm run build:flow-core` ' +
        `from the sfdt root? Underlying error: ${err.message}`,
    );
  }
  return _contract;
}
const HOST_VERSION = (() => {
  try {
    return require('../package.json').version;
  } catch {
    return '0.0.0';
  }
})();
const MAX_RESPONSE_BYTES = 1024 * 1024;
function writeFrame(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_RESPONSE_BYTES) {
    const trimmed = {
      ok: false,
      requestId: payload?.requestId ?? 'unknown',
      error: `Response too large (${body.length} bytes; native messaging limit is ${MAX_RESPONSE_BYTES}).`,
      code: 'INTERNAL_ERROR',
    };
    return writeFrame(trimmed);
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}
function setupStdinReader(onMessage) {
  let buffer = Buffer.alloc(0);
  const drain = async () => {
    while (true) {
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (buffer.length < 4 + length) return;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      let parsed;
      try {
        parsed = JSON.parse(body.toString('utf8'));
      } catch (err) {
        writeFrame({
          ok: false,
          requestId: 'parse-error',
          error: `Invalid JSON frame: ${err.message}`,
          code: 'REQUEST_INVALID',
        });
        continue;
      }
      await onMessage(parsed);
    }
  };
  process.stdin.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    drain().catch((err) => {
      writeFrame({
        ok: false,
        requestId: 'fatal',
        error: err.message,
        code: 'INTERNAL_ERROR',
      });
    });
  });
  process.stdin.on('end', () => process.exit(0));
}
async function dispatch(request) {
  const { makeSuccessResponse, makeErrorResponse } = await loadContract();
  switch (request.kind) {
    case 'ping':
      return makeSuccessResponse(request.requestId, {
        pong: true,
        serverVersion: HOST_VERSION,
        transport: 'native',
      });
    case 'version': {
      try {
        const { stdout } = await execa('sfdt', ['version'], { timeout: 5000 });
        return makeSuccessResponse(request.requestId, { version: stdout.trim() });
      } catch {
        return makeSuccessResponse(request.requestId, {
          version: `host-${HOST_VERSION}`,
        });
      }
    }
    case 'quality':
    case 'deploy':
    case 'rollback':
    case 'ai':
    case 'drift':
    case 'scan':
    case 'compare':
      return makeErrorResponse(
        request.requestId,
        `Request kind "${request.kind}" is not yet implemented on the native host.`,
        'NOT_IMPLEMENTED',
      );
    default:
      return makeErrorResponse(
        request.requestId,
        `Unknown request kind: ${request.kind}`,
        'REQUEST_INVALID',
      );
  }
}
export async function handleMessage(raw) {
  const { validateSfdtRequest, makeErrorResponse } = await loadContract();
  const validation = validateSfdtRequest(raw);
  if (!validation.ok) {
    const requestId = typeof raw?.requestId === 'string' ? raw.requestId : 'unknown';
    return makeErrorResponse(
      requestId,
      'Invalid request: ' + validation.errors.map((e) => `${e.field} ${e.reason}`).join('; '),
      'REQUEST_INVALID',
    );
  }
  try {
    return await dispatch(validation.request);
  } catch (err) {
    return makeErrorResponse(validation.request.requestId, err.message, 'INTERNAL_ERROR');
  }
}
async function main() {
  const smokeArg = process.argv.find((a) => a.startsWith('--smoke='));
  if (smokeArg) {
    const json = smokeArg.slice('--smoke='.length);
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch (err) {
      writeFrame({
        ok: false,
        requestId: 'smoke',
        error: `--smoke payload was not valid JSON: ${err.message}`,
        code: 'REQUEST_INVALID',
      });
      process.exit(1);
    }
    const response = await handleMessage(parsed);
    writeFrame(response);
    process.exit(0);
  }
  setupStdinReader(async (msg) => {
    const response = await handleMessage(msg);
    writeFrame(response);
  });
}
main().catch((err) => {
  writeFrame({
    ok: false,
    requestId: 'fatal',
    error: err.message,
    code: 'INTERNAL_ERROR',
  });
  process.exit(1);
});
