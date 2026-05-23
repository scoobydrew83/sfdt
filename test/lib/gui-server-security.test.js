/**
 * Unit tests for src/lib/gui-server/security.js.
 *
 * These run the middleware functions directly with hand-rolled req/res
 * doubles so we can prove that the tightened origin guard rejects mutating
 * requests with no Origin header — supertest tests can't cover that path
 * because the global setup file auto-injects Origin.
 */

import { describe, it, expect, vi } from 'vitest';
import { createOriginGuard, createCsrfToken, requireCsrfToken } from '../../src/lib/gui-server/security.js';

function makeRes() {
  return {
    statusCode: null,
    body: null,
    get: vi.fn(),
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function makeReq({ method = 'GET', origin, csrfHeader } = {}) {
  return {
    method,
    headers: origin === undefined ? {} : { origin },
    get(name) {
      if (name.toLowerCase() === 'x-sfdt-csrf') return csrfHeader;
      return undefined;
    },
  };
}

describe('createOriginGuard', () => {
  const guard = createOriginGuard(7654);

  it('allows GET requests with no Origin header (same-origin React fetch)', () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBeNull();
  });

  it('allows HEAD and OPTIONS requests with no Origin header', () => {
    for (const method of ['HEAD', 'OPTIONS']) {
      const req = makeReq({ method });
      const res = makeRes();
      const next = vi.fn();
      guard(req, res, next);
      expect(next).toHaveBeenCalled();
    }
  });

  it('rejects POST requests with no Origin header (M1 regression)', () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'Forbidden' });
  });

  it('rejects PATCH and DELETE with no Origin header', () => {
    for (const method of ['PATCH', 'DELETE', 'PUT']) {
      const req = makeReq({ method });
      const res = makeRes();
      const next = vi.fn();
      guard(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(403);
    }
  });

  it('rejects POST with a disallowed Origin', () => {
    const req = makeReq({ method: 'POST', origin: 'http://evil.example.com' });
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it('allows POST with a matching localhost Origin', () => {
    const req = makeReq({ method: 'POST', origin: 'http://localhost:7654' });
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('allows POST with the 127.0.0.1 alias of the configured port', () => {
    const req = makeReq({ method: 'POST', origin: 'http://127.0.0.1:7654' });
    const res = makeRes();
    const next = vi.fn();
    guard(req, res, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('CSRF token helpers', () => {
  it('createCsrfToken returns 32 bytes of base64url entropy', () => {
    const token = createCsrfToken();
    expect(typeof token).toBe('string');
    // 32 bytes → 43 base64url chars (no padding)
    expect(token.length).toBe(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('requireCsrfToken returns false and writes 403 when header is missing', () => {
    const req = makeReq({ method: 'POST' });
    const res = makeRes();
    const ok = requireCsrfToken(req, res, 'expected-token');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('requireCsrfToken returns false when header value mismatches', () => {
    const req = makeReq({ method: 'POST', csrfHeader: 'wrong' });
    const res = makeRes();
    const ok = requireCsrfToken(req, res, 'expected-token');
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('requireCsrfToken returns true and does not touch res when header matches', () => {
    const req = makeReq({ method: 'POST', csrfHeader: 'right-token' });
    const res = makeRes();
    const ok = requireCsrfToken(req, res, 'right-token');
    expect(ok).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});
