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
// Chrome's documented extension→host limit is 64 MB, but the host only ever
// needs to receive SfdtRequest envelopes (a few KB at most for routine calls,
// up to a couple hundred KB for the largest realistic flow-quality payload).
// Cap at 4 MB so a 0xFFFFFFFF length header — which would otherwise allocate
// 4 GB before any validation runs — fails fast.
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

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
  // Concurrency guard: process.stdin can emit `data` for a new chunk while a
  // previous drain() is still awaiting onMessage(). Without this lock, two
  // drain() invocations could observe the same buffer state and either
  // advance past the same frame twice or interleave their `buffer =
  // buffer.subarray(...)` writes, corrupting the framing. Chrome's native
  // messaging protocol is half-duplex in practice so this rarely triggers,
  // but the implementation is racy without it.
  let draining = false;
  let pending = false;

  const drain = async () => {
    if (draining) {
      // Mark that more data arrived. The active drain() will re-check
      // `pending` after each frame and keep going until the buffer is
      // either drained or short of a complete frame.
      pending = true;
      return;
    }
    draining = true;
    try {
      do {
        pending = false;
        while (buffer.length >= 4) {
          const length = buffer.readUInt32LE(0);
          if (length > MAX_REQUEST_BYTES) {
            // Reject the frame; Chrome closes the channel after an oversized
            // message, so exiting prevents a multi-GB allocation on the
            // next loop iteration.
            writeFrame({
              ok: false,
              requestId: 'oversized',
              error: `Frame length ${length} exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
              code: 'REQUEST_INVALID',
            });
            process.exit(1);
          }
          if (buffer.length < 4 + length) break;
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
      } while (pending);
    } finally {
      draining = false;
    }
  };

  process.stdin.on('data', (chunk) => {
    // Guard the ACCUMULATING buffer, not just the per-frame length. A peer
    // streaming a 4 MB - 1 byte partial frame with a valid length header
    // would otherwise hold that memory indefinitely. MAX_REQUEST_BYTES + a
    // small headroom for the 4-byte length prefix and any chunk-boundary
    // overshoot keeps the buffer bounded while still accepting legitimate
    // back-to-back frames.
    const projectedSize = buffer.length + chunk.length;
    if (projectedSize > MAX_REQUEST_BYTES + 1024) {
      writeFrame({
        ok: false,
        requestId: 'overflow',
        error: `Accumulated stdin buffer ${projectedSize} exceeds the ${MAX_REQUEST_BYTES}-byte limit`,
        code: 'REQUEST_INVALID',
      });
      process.exit(1);
    }
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
    case 'org-health':
      return makeErrorResponse(
        request.requestId,
        `Request kind "${request.kind}" is not available via the native messaging host, ` +
          'which is a limited fallback transport. This operation requires the HTTP bridge: ' +
          'run `sfdt ui` in your Salesforce project to start it, then retry.',
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
