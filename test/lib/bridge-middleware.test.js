/**
 * Unit tests for the bridge HTTP middleware in isolation
 * (src/lib/bridge/middleware.js): origin allowlist + CORS behaviour and
 * bearer-token authentication. The token loader is mocked so no filesystem
 * or homedir access happens; comparison still uses the real
 * constantTimeEqual.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { FIXED_TOKEN, getOrCreateBridgeToken } = vi.hoisted(() => ({
  FIXED_TOKEN: 'test-bridge-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  getOrCreateBridgeToken: vi.fn(),
}));

vi.mock('../../src/lib/bridge/token.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, getOrCreateBridgeToken };
});

import {
  createBridgeCorsMiddleware,
  createBridgeAuthMiddleware,
} from '../../src/lib/bridge/middleware.js';

const PORT = 7654;

// Minimal Express-shaped req/res doubles — enough surface for the middleware.
function mockReq({ method = 'GET', origin, authorization } = {}) {
  const headers = {};
  if (origin !== undefined) headers.origin = origin;
  if (authorization !== undefined) headers.authorization = authorization;
  return {
    method,
    headers,
    get: (name) => headers[name.toLowerCase()],
  };
}

function mockRes() {
  return {
    statusCode: null,
    headers: {},
    body: undefined,
    ended: false,
    set(k, v) {
      this.headers[k] = v;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

function runCors(reqOpts) {
  const middleware = createBridgeCorsMiddleware(PORT);
  const req = mockReq(reqOpts);
  const res = mockRes();
  const next = vi.fn();
  middleware(req, res, next);
  return { res, next };
}

async function runAuth(reqOpts) {
  const middleware = createBridgeAuthMiddleware();
  const req = mockReq(reqOpts);
  const res = mockRes();
  const next = vi.fn();
  await middleware(req, res, next);
  return { res, next };
}

beforeEach(() => {
  getOrCreateBridgeToken.mockReset().mockResolvedValue(FIXED_TOKEN);
});

describe('createBridgeCorsMiddleware — origin allowlist', () => {
  it('allows requests with no Origin header (non-browser callers) without CORS headers', () => {
    const { res, next } = runCors({});
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
    expect(res.headers).toEqual({});
  });

  it.each([
    `http://localhost:${PORT}`,
    `http://127.0.0.1:${PORT}`,
    'https://na1.salesforce.com',
    'https://myorg.salesforce-setup.com',
    'https://myorg.my.salesforce.com',
    'https://myorg.lightning.force.com',
    'https://myorg--c.vf.force.com',
    'https://myorg--pkg.visualforce.com',
    `chrome-extension://${'a'.repeat(32)}`,
  ])('allows origin %s', (origin) => {
    const { res, next } = runCors({ origin });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
    expect(res.headers['Access-Control-Allow-Origin']).toBe(origin);
  });

  it.each([
    'https://evil.example.com',
    'https://evil.force.com.attacker.com', // anchored suffix match must hold
    'http://myorg.my.salesforce.com', // https only
    `http://localhost:${PORT + 1}`, // wrong port
    `chrome-extension://${'a'.repeat(31)}`, // wrong id length
    `chrome-extension://${'z'.repeat(32)}`, // chars outside [a-p]
    'null',
  ])('rejects origin %s with 403 BRIDGE_FORBIDDEN', (origin) => {
    const { res, next } = runCors({ origin });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      ok: false,
      error: 'Origin not in bridge allowlist',
      code: 'BRIDGE_FORBIDDEN',
    });
  });

  it('sets the full CORS header set for an allowed browser origin', () => {
    const origin = 'https://myorg.my.salesforce.com';
    const { res } = runCors({ origin });
    expect(res.headers).toEqual({
      'Access-Control-Allow-Origin': origin,
      Vary: 'Origin',
      'Access-Control-Allow-Credentials': 'false',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    });
  });

  it('answers OPTIONS pre-flight with 204 and does not fall through', () => {
    const { res, next } = runCors({ method: 'OPTIONS', origin: 'https://myorg.my.salesforce.com' });
    expect(res.statusCode).toBe(204);
    expect(res.ended).toBe(true);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('createBridgeAuthMiddleware — bearer token', () => {
  it('calls next() for a valid bearer token', async () => {
    const { res, next } = await runAuth({ authorization: `Bearer ${FIXED_TOKEN}` });
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBeNull();
  });

  it('accepts a case-insensitive "bearer" prefix and trims whitespace', async () => {
    const { next } = await runAuth({ authorization: `bearer   ${FIXED_TOKEN}  ` });
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 when the Authorization header is missing', async () => {
    const { res, next } = await runAuth({});
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ ok: false, error: 'Bearer token required', code: 'BRIDGE_UNAUTHORIZED' });
  });

  it('returns 401 for a non-Bearer scheme', async () => {
    const { res } = await runAuth({ authorization: `Basic ${FIXED_TOKEN}` });
    expect(res.statusCode).toBe(401);
    expect(res.body.code).toBe('BRIDGE_UNAUTHORIZED');
  });

  it('returns 401 for a Bearer header with an empty token', async () => {
    const { res } = await runAuth({ authorization: 'Bearer    ' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 for a pathologically long Authorization header (> 4 KB)', async () => {
    const { res, next } = await runAuth({ authorization: `Bearer ${'a'.repeat(5000)}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 for a wrong token and never leaks the expected value', async () => {
    const { res, next } = await runAuth({ authorization: 'Bearer wrong-token-bbbbbbbbbbbbbbbbbbbbbbbbbb' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'Invalid bridge token', code: 'BRIDGE_UNAUTHORIZED' });
    expect(JSON.stringify(res.body)).not.toContain(FIXED_TOKEN);
  });

  it('rejects a token that is a strict prefix of the expected token', async () => {
    const { res } = await runAuth({ authorization: `Bearer ${FIXED_TOKEN.slice(0, -1)}` });
    expect(res.statusCode).toBe(403);
  });

  it('returns 500 when the bridge token cannot be loaded', async () => {
    getOrCreateBridgeToken.mockRejectedValue(new Error('disk on fire'));
    const { res, next } = await runAuth({ authorization: `Bearer ${FIXED_TOKEN}` });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: 'Bridge token unavailable: disk on fire',
      code: 'INTERNAL_ERROR',
    });
  });
});
