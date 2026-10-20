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
//
// ── Keeping this in step with supertest ─────────────────────────────────────
//
// Both patches reach into supertest's internals, so they have to be re-read
// against `node_modules/supertest/lib/test.js` on every bump. 7.3.1 changed two
// things this file depends on: `Test` is now a class (its prototype methods are
// still writable, so the patching style is unchanged), and `serverAddress` now
// binds with an explicit host and defers the URL until the port is known —
// which is why `SHARED_HOST` and `resolveSharedUrl` below exist.

import http from 'http';
import { afterAll } from 'vitest';
import request, { Test } from 'supertest';

const DEFAULT_TEST_ORIGIN = 'http://localhost:7654';

// Bind the shared server to the same address the client connects to. A wildcard
// bind (`listen(0)`, which is what this file used to do) can share its port with
// another process's `127.0.0.1` listener, and the request then reaches that
// process instead — which is the "403 from an app that never saw the request"
// entry in the sfdt-private#8 symptom table, because the responding
// `createGuiApp` instance minted a different CSRF token. supertest moved its own
// bind to `listen(0, '127.0.0.1')` in 7.3.x for exactly this reason; see the
// comment in its `serverAddress`. Leaving the patch on a wildcard bind kept that
// one mechanism of the flake class live underneath the 2026-09-02 fix.
const SHARED_HOST = '127.0.0.1';

const tokenCache = new WeakMap();

const originalEnd = Test.prototype.end;
const originalServerAddress = Test.prototype.serverAddress;

function getHeader(testInstance, name) {
  const headers = testInstance._header || {};
  return headers[name] || headers[name.toLowerCase()];
}

// supertest wraps a bare Express app in an `http.Server` before it builds the
// `Test`. The underlying Express app function is reachable as
// `server._events.request` and IS stable across requests, so both the CSRF
// cache and the shared-server map key off of that rather than off of
// `this.app` (the per-`request()` Server wrapper).
function appHandler(app) {
  if (typeof app === 'function') return app;
  const handler = app?._events?.request;
  return typeof handler === 'function' ? handler : null;
}

// ── Shared listening servers ────────────────────────────────────────────────
//
// supertest builds a *new* `http.Server` around the Express app for every
// `request(app)` call and listens it on an ephemeral port, then closes it once
// the last response from that call has been asserted. (7.3.1 shares one socket
// between the `Test`s of a single `request()` factory and closes it by
// refcount, but these suites call `request(app)` once per request, so it is
// still one bind/close cycle each.) Measured on this repo, one worker's share
// of the gui-server suites does ~57 of those cycles; the 26 suites together do
// well over a thousand, all against the one loopback ephemeral port range that
// every concurrently-running vitest worker shares.
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

function sharedUrl(server, path) {
  return `http://${SHARED_HOST}:${server.address().port}${path}`;
}

Test.prototype.serverAddress = function patchedServerAddress(app, path) {
  // A server the test started itself (e.g. via `startGuiServer`) is already
  // listening on a port it chose — leave supertest's own handling alone.
  if (typeof app?.address === 'function' && app.address()) {
    return originalServerAddress.call(this, app, path);
  }

  const handler = appHandler(app);
  if (!handler) return originalServerAddress.call(this, app, path);

  let entry = serverByApp.get(handler);
  if (!entry) {
    const server = http.createServer(handler);
    const ready = new Promise((resolve, reject) => {
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      const onError = (err) => {
        server.removeListener('listening', onListening);
        reject(err);
      };
      server.once('listening', onListening);
      server.once('error', onError);
    });
    // Binding to a host runs the address through a lookup, so unlike a wildcard
    // `listen(0)` this resolves on a later tick and the port is not readable
    // here. `patchedEnd` fills the URL in before it dispatches — the same
    // two-step supertest itself does with `_serverPath`. The `error` listener
    // matters as much as the port: an unhandled `EADDRINUSE` from this bind
    // would take down the whole worker, which is the "whole-file cascade"
    // symptom rather than a failure anyone could attribute.
    server.listen(0, SHARED_HOST);
    server.unref();
    entry = { server, ready };
    serverByApp.set(handler, entry);
    openedServers.add(server);
  }

  // Deliberately NOT `this._server = entry.server`: supertest's `end()` closes
  // `this._server` once the last request on it settles, and this one outlives
  // every individual request.
  this._sfdtShared = entry;
  this._sfdtSharedPath = path;
  return entry.server.listening
    ? sharedUrl(entry.server, path)
    : `http://${SHARED_HOST}${path}`;
};

// Returns null — meaning "the URL is already final, dispatch synchronously" —
// for every request after the first against a given app, which is the common
// case. Only the request that opened the socket has to wait for the bind.
function resolveSharedUrl(testInstance) {
  const entry = testInstance._sfdtShared;
  if (!entry) return null;
  if (entry.server.listening) {
    testInstance.url = sharedUrl(entry.server, testInstance._sfdtSharedPath);
    return null;
  }
  return entry.ready.then(() => {
    testInstance.url = sharedUrl(entry.server, testInstance._sfdtSharedPath);
  });
}

afterAll(() => {
  for (const server of openedServers) server.close();
  openedServers.clear();
});

// Fetch the app's CSRF token, retrying once. Resolves with the token or
// rejects with a message that names the transport failure — never resolves
// with "no token", because sending the real request without one just moves
// the failure to an unrelated assertion three lines later.
function fetchCsrfToken(target, launchToken) {
  return new Promise((resolve, reject) => {
    const attempt = (retriesLeft, previous) => {
      const req = request(target).get('/api/csrf-token');
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

// Dispatch once the prerequisites this file introduces have settled: the shared
// socket's bind, and the CSRF token fetch. Surfacing either failure as itself is
// the point — a request sent without a token draws a legitimate 403 that then
// fails some unrelated status assertion.
function dispatchWhen(testInstance, ready, tokenPromise, fn) {
  Promise.all([ready, tokenPromise]).then(
    ([, token]) => {
      if (token) testInstance.set('X-SFDT-CSRF', token);
      originalEnd.call(testInstance, fn);
    },
    (err) => {
      if (fn) return fn.call(testInstance, err);
      throw err;
    },
  );
  return testInstance;
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

  // `this.url` carries the request path whether or not the port is known yet,
  // so these two checks are safe to run before `resolveSharedUrl`.
  const isCsrfTokenRequest = (this.url || '').includes('/api/csrf-token');

  if (isCsrfTokenRequest && launchToken && !getHeader(this, 'authorization')) {
    this.set('Authorization', `Bearer ${launchToken}`);
  }

  const skipCsrf =
    getHeader(this, 'x-sfdt-csrf') ||
    isCsrfTokenRequest ||
    (this.url || '').includes('/api/health');

  const ready = resolveSharedUrl(this);

  if (skipCsrf) {
    if (!ready) return originalEnd.call(this, fn);
    return dispatchWhen(this, ready, null, fn);
  }

  const self = this;

  // Cache the *promise*, not the token: two mutating requests issued against
  // the same cold app would otherwise both miss and both fetch.
  let pending = handler ? tokenCache.get(handler) : null;
  if (!pending) {
    // Hand `request()` the Express app function, not `self.app`. Under 7.3.1 a
    // `request()` factory's Server is shared by the Tests it creates and closed
    // when the last of them settles; reusing `self.app` here would enrol this
    // pre-flight in the outer request's refcount and let it close the socket
    // out from under the request that asked for the token. Passing the handler
    // gets a fresh (never-listened) wrapper that still resolves to the same
    // shared socket via `appHandler`.
    pending = fetchCsrfToken(handler || self.app, launchToken);
    if (handler) {
      // Don't strand a rejection, and don't let one transport hiccup poison
      // every later test in the file.
      pending.catch(() => {
        if (tokenCache.get(handler) === pending) tokenCache.delete(handler);
      });
      tokenCache.set(handler, pending);
    }
  }

  return dispatchWhen(self, ready, pending, fn);
};
