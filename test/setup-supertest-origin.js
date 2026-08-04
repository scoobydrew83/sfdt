// Vitest setup file: keep the gui-server's security middleware happy from
// inside the in-process test client.
//
// The gui-server now rejects mutating requests that arrive without an
// `Origin` header, and rejects them again if the route requires CSRF and the
// `X-SFDT-CSRF` header is missing. Real browsers always set Origin on
// cross-origin POSTs to http://localhost:7654 and the React app fetches the
// CSRF token from `/api/csrf-token` before mutating requests. Tests are
// supposed to mimic that browser behavior, but doing it by hand in every
// `describe` block is 90+ test sites of churn. Instead we monkey-patch
// supertest's `Test.prototype.end`:
//
//   1. Inject `Origin: http://localhost:7654` whenever a request is missing
//      that header.
//   2. For non-safe methods, transparently fetch and cache a CSRF token from
//      `/api/csrf-token` for the app under test, then attach
//      `X-SFDT-CSRF: <token>` before the original request fires.
//
// Tests that explicitly set their own X-SFDT-CSRF (e.g. to assert behavior
// when the token is wrong) are left untouched.

import request, { Test } from 'supertest';

const DEFAULT_TEST_ORIGIN = 'http://localhost:7654';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const tokenCache = new WeakMap();

const originalEnd = Test.prototype.end;

function getHeader(testInstance, name) {
  const headers = testInstance._header || {};
  return headers[name] || headers[name.toLowerCase()];
}

// supertest wraps the Express app in an ephemeral http.Server per Test
// instance. The underlying Express app function is reachable as
// `server._events.request` and IS stable across requests, so we key the
// CSRF cache off of that rather than off of `this.app` (the per-request
// Server wrapper).
function cacheKey(testInstance) {
  const app = testInstance.app;
  if (!app) return null;
  if (typeof app === 'function') return app;
  const handler = app._events?.request;
  return handler || app;
}

Test.prototype.end = function patchedEnd(fn) {
  if (!getHeader(this, 'origin') && !getHeader(this, 'Origin')) {
    this.set('Origin', DEFAULT_TEST_ORIGIN);
  }

  const appFn = typeof this.app === 'function' ? this.app : this.app?._events?.request;
  const launchToken = appFn?.launchToken;

  if ((this.url || '').includes('/api/csrf-token') && launchToken && !getHeader(this, 'authorization') && !getHeader(this, 'Authorization')) {
    this.set('Authorization', `Bearer ${launchToken}`);
  }

  const skipCsrf =
    getHeader(this, 'x-sfdt-csrf') ||
    (this.url || '').includes('/api/csrf-token') ||
    (this.url || '').includes('/api/health');

  if (skipCsrf) {
    return originalEnd.call(this, fn);
  }

  const key = cacheKey(this);
  const cached = key ? tokenCache.get(key) : null;
  if (cached) {
    this.set('X-SFDT-CSRF', cached);
    return originalEnd.call(this, fn);
  }

  // First mutating request against this app — fetch the token.
  const self = this;

  const req = request(self.app).get('/api/csrf-token');
  if (launchToken) {
    req.set('Authorization', `Bearer ${launchToken}`);
  }

  // A failed token fetch used to fall through silently, sending the real
  // request with no `X-SFDT-CSRF` header. The server then correctly answered
  // 403 — and the test failed asserting some unrelated status, with nothing
  // pointing at the token fetch. That turned any transient hiccup here into a
  // mystery flake (seen intermittently in bridge-routes-extra, gui-server-routes3
  // and gui-server-manifest-builder). `/api/csrf-token` is itself rate-limited
  // (10/min), so a burst of cache misses against one app is a plausible trigger.
  //
  // So: retry once, and if it still fails, say so loudly instead of letting the
  // request go out unauthenticated and fail somewhere confusing.
  const attach = (token) => {
    if (key) tokenCache.set(key, token);
    self.set('X-SFDT-CSRF', token);
  };

  req.end((err, tokenRes) => {
    const token = tokenRes?.body?.token;
    if (!err && token) {
      attach(token);
      return originalEnd.call(self, fn);
    }

    const retry = request(self.app).get('/api/csrf-token');
    if (launchToken) retry.set('Authorization', `Bearer ${launchToken}`);
    retry.end((retryErr, retryRes) => {
      const retryToken = retryRes?.body?.token;
      if (!retryErr && retryToken) {
        attach(retryToken);
      } else {
        console.error(
          `[setup-supertest-origin] could not obtain a CSRF token for ${self.method} ${self.url} — ` +
            `the request will be sent without one and the server will answer 403. ` +
            `first attempt: status=${tokenRes?.status} err=${err?.message}; ` +
            `retry: status=${retryRes?.status} err=${retryErr?.message}`,
        );
      }
      originalEnd.call(self, fn);
    });
  });
  return self;
};
