#!/usr/bin/env node
/**
 * @sfdt/host — Chrome Native Messaging host for the SFDT SF Helper
 * extension.
 *
 * Protocol (https://developer.chrome.com/docs/apps/nativeMessaging):
 *
 *   Each message is a UTF-8 JSON document preceded by a 4-byte little-endian
 *   unsigned int containing the document's byte length. Chrome sends up to
 *   64 MB per message; the host may reply with up to 1 MB.
 *
 * Why this exists: the extension's primary transport is HTTP to the running
 * `sfdt ui` server on http://127.0.0.1:7654. When that server is not running,
 * this host is the fallback: the extension launches it via
 * `chrome.runtime.connectNative('com.sfdt.host')`, sends a framed SfdtRequest,
 * and waits for the framed SfdtResponse.
 *
 * Handlers for individual request kinds live in handleRequest below. The
 * routing mirrors the HTTP /api/bridge/exchange dispatcher in
 * sfdt/src/lib/bridge/routes.js so the extension can be written against a
 * single SfdtRequest/SfdtResponse contract regardless of transport.
 */

import { execa } from 'execa';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// flow-core's bridge-contract module ships compiled to dist/. Load it
// lazily; if the build is missing we still respond to messages with a
// useful error rather than crashing the host.
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

// ─── Framing ────────────────────────────────────────────────────────────────

const MAX_RESPONSE_BYTES = 1024 * 1024; // Chrome's host→extension limit

function writeFrame(payload) {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, 'utf8');
  if (body.length > MAX_RESPONSE_BYTES) {
    // Truncate to something Chrome will accept; preserve the requestId so
    // the extension can correlate.
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
      // eslint-disable-next-line no-await-in-loop
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

// ─── Request handling ───────────────────────────────────────────────────────

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
      // The native host runs at extension-installer time, before sfdt is
      // necessarily on PATH. Try sfdt first; fall back to our own version.
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

// ─── Entrypoint ─────────────────────────────────────────────────────────────

async function main() {
  // --smoke mode: read a single JSON request from argv[2], write the framed
  // response to stdout, and exit. Used by tests and by humans poking at the
  // host without running Chrome.
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

  // Stdio (native messaging) mode.
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
