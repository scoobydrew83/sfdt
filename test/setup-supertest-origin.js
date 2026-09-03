// Vitest setup file: keep the gui-server's security middleware happy from
// inside the in-process test client, and keep the transport underneath
// supertest boring enough that it cannot invent failures of its own.
//
// ── Part 1: security headers ────────────────────────────────────────────────
//
// The gui-server rejects mutating requests that arrive without an `Origin`
// header, and rejects them again if the route requires CSRF and the
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
//
// ── Part 2: one listening socket per app, not per request ───────────────────
//
// See the comment on `patchedServerAddress` below. This is the fix for
// sfdt-private#8 — the `gui-server-*` / `bridge-routes-extra` flake class.

import http from 'http';
import { afterAll } from 'vitest';
import request, { Test } from 'supertest';

const DEFAULT_TEST_ORIGIN = 'http://localhost:7654';
const tokenCache = new WeakMap();

const originalEnd = Test.prototype.end;
const originalServerAddress = Test.prototype.serverAddress;

function getHeader(testInstance, name) {
  const headers = testInstance._header || {};
  return headers[name] || headers[name.toLowerCase()];
}

// supertest wraps the Express app in an ephemeral http.Server per Test
// instance. The underlying Express app function is reachable as
// `server._events.request` and IS stable across requests, so both the CSRF
// cache and the shared-server map key off of that rather than off of
// `this.app` (the per-request Server wrapper).
function appHandler(app) {
  if (typeof app === 'function') return app;
  const handler = app?._events?.request;
  return typeof handler === 'function' ? handler : null;
}

// ── Shared listening servers ────────────────────────────────────────────────
//
// supertest 7 builds a *new* `http.Server` around the Express app and calls
// `listen(0)` for every single `request(app)`, then `close()`s it once the
// response has been asserted. Measured on this repo, one worker's share of
// the gui-server suites does ~57 of those bind/close cycles; the 26 suites
// together do well over a thousand, all against the one loopback ephemeral
// port range that every concurrently-running vitest worker shares.
//
// That is the only cross-process resource these suites touch — they are the
// only cli suites that speak real TCP at all — and it is what the flake class
// in sfdt-private#8 is made of. Every symptom on that list is a transport
// symptom, never a handler symptom: `socket hang up`, a request that never
// answers inside the 5s test timeout, a 403 that means the response came from
// a *different* `createGuiApp` instance (each one mints its own CSRF token),
// a 404 for a route the app under test demonstrably has. The product is never
// wrong in any of them — it "fails safe" because it was never asked.
//
// So: listen once per Express app, reuse that socket for every request in the
// file, and close it when the file is done. The apps themselves stay
// per-`describe`, so nothing about test isolation is weakened — what goes away
// is a thousand kernel-level bind/close races per run.
const serverByApp = new WeakMap();
const openedServers = new Set();

Test.prototype.serverAddress = function patchedServerAddress(app, path) {
  // A server the test started itself (e.g. via `startGuiServer`) is already
  // listening on a port it chose — leave supertest's own handling alone.
  if (typeof app?.address === 'function' && app.address()) {
    return originalServerAddress.call(this, app, path);
  }

  const handler = appHandler(app);
  if (!handler) return originalServerAddress.call(this, app, path);

  let server = serverByApp.get(handler);
  if (!server) {
    server = http.createServer(handler);
    // `listen(0)` with no host binds synchronously, so `address()` is readable
    // on the next line — the same assumption supertest itself makes.
    server.listen(0);
    server.unref();
    serverByApp.set(handler, server);
    openedServers.add(server);
  }

  // Deliberately NOT `this._server = server`: supertest's `end()` closes
  // `this._server`, and this one outlives the request.
  return `http://127.0.0.1:${server.address().port}${path}`;
};

afterAll(() => {
  for (const server of openedServers) server.close();
  openedServers.clear();
});

// Fetch the app's CSRF token, retrying once. Resolves with the token or
// rejects with a message that names the transport failure — never resolves
// with "no token", because sending the real request without one just moves
// the failure to an unrelated assertion three lines later.
function fetchCsrfToken(app, launchToken) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft, previous) => {
      const req = request(app).get('/api/csrf-token');
      if (launchToken) req.set('Authorization', `Bearer ${launchToken}`);
      req.end((err, res) => {
        const token = res?.body?.token;
        if (!err && token) return resolve(token);

        const detail = `status=${res?.status} err=${err?.message}`;
        if (retriesLeft > 0) return attempt(retriesLeft - 1, detail);
        reject(
          new Error(
            '[setup-supertest-origin] could not obtain a CSRF token from ' +
              `/api/csrf-token. first attempt: ${previous}; retry: ${detail}`,
          ),
        );
      });
    };
    attempt(1, null);
  });
}

Test.prototype.end = function patchedEnd(fn) {
  if (!getHeader(this, 'origin')) {
    this.set('Origin', DEFAULT_TEST_ORIGIN);
  }

  // One TCP connection per request. The listening socket is now shared across
  // a whole file, so without this Node's keep-alive agent would pool sockets
  // and could write a request onto one the server is retiring at its 5s
  // `keepAliveTimeout` — a reset that reads exactly like the flake we just
  // removed. Matches the pre-existing behaviour, where a per-request server
  // was torn down immediately anyway.
  if (!getHeader(this, 'connection')) {
    this.set('Connection', 'close');
  }

  const handler = appHandler(this.app);
  const launchToken = handler?.launchToken;

  const isCsrfTokenRequest = (this.url || '').includes('/api/csrf-token');

  if (isCsrfTokenRequest && launchToken && !getHeader(this, 'authorization')) {
    this.set('Authorization', `Bearer ${launchToken}`);
  }

  const skipCsrf =
    getHeader(this, 'x-sfdt-csrf') ||
    isCsrfTokenRequest ||
    (this.url || '').includes('/api/health');

  if (skipCsrf) {
    return originalEnd.call(this, fn);
  }

  const self = this;

  // Cache the *promise*, not the token: two mutating requests issued against
  // the same cold app would otherwise both miss and both fetch.
  let pending = handler ? tokenCache.get(handler) : null;
  if (!pending) {
    pending = fetchCsrfToken(self.app, launchToken);
    if (handler) {
      // Don't strand a rejection, and don't let one transport hiccup poison
      // every later test in the file.
      pending.catch(() => {
        if (tokenCache.get(handler) === pending) tokenCache.delete(handler);
      });
      tokenCache.set(handler, pending);
    }
  }

  pending.then(
    (token) => {
      self.set('X-SFDT-CSRF', token);
      originalEnd.call(self, fn);
    },
    (err) => {
      // Surface the token failure itself rather than the 403 it would cause.
      if (fn) return fn.call(self, err);
      throw err;
    },
  );

  return self;
};
