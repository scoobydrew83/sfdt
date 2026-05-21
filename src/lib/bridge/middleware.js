/**
 * Bridge HTTP middleware.
 *
 * Three responsibilities, applied in order to every /api/bridge/* request:
 *
 *  1. Origin allowlist — only Chrome extensions and Salesforce domains may
 *     call the bridge. Localhost is always allowed for testing.
 *  2. CORS headers — the bridge speaks to cross-origin callers, so it must
 *     echo the Origin and advertise the Authorization header.
 *  3. Bearer token check — the request must carry `Authorization: Bearer
 *     <token>` matching ~/.sfdt/bridge-token.
 *
 * The middleware factory returns separate middlewares so individual routes
 * can opt out (e.g. the discovery ping requires CORS but not auth).
 */

import { getOrCreateBridgeToken, constantTimeEqual } from './token.js';

const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/[a-z0-9-]+\.salesforce\.com$/i,
  /^https:\/\/[a-z0-9-]+\.salesforce-setup\.com$/i,
  /^https:\/\/[a-z0-9-]+\.my\.salesforce\.com$/i,
  /^https:\/\/[a-z0-9-]+\.lightning\.force\.com$/i,
  // Chrome assigns extension IDs as exactly 32 chars from [a-p] (mapped hex).
  /^chrome-extension:\/\/[a-p]{32}$/,
];

function isAllowedOrigin(origin, localhostOrigins) {
  // Missing Origin is intentionally permitted here. The bridge accepts
  // non-browser callers (the @sfdt/host native messaging process and curl-style
  // smoke tests), and those never send an Origin header. The authoritative
  // access control on this surface is the bearer-token check in
  // createBridgeBearerAuthMiddleware — without a valid token any caller is
  // rejected regardless of origin. Unlike the gui-server's same-origin CSRF
  // model (which DOES require Origin on mutating requests), this endpoint is
  // explicitly cross-origin and bearer-authenticated.
  if (!origin) return true;
  if (localhostOrigins.has(origin)) return true;
  return ALLOWED_ORIGIN_PATTERNS.some((p) => p.test(origin));
}

/**
 * Origin allowlist + CORS headers. Pre-flight OPTIONS requests are answered
 * without falling through to the route handler.
 *
 * @param {number} port - The port the gui server is listening on.
 * @returns {import('express').RequestHandler}
 */
export function createBridgeCorsMiddleware(port) {
  const localhostOrigins = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  return (req, res, next) => {
    const origin = req.headers.origin;

    if (!isAllowedOrigin(origin, localhostOrigins)) {
      return res.status(403).json({
        ok: false,
        error: 'Origin not in bridge allowlist',
        code: 'BRIDGE_FORBIDDEN',
      });
    }

    if (origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Vary', 'Origin');
      res.set('Access-Control-Allow-Credentials', 'false');
      res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '600');
    }

    if (req.method === 'OPTIONS') {
      return res.status(204).end();
    }
    next();
  };
}

/**
 * Bearer-token authentication. Reads the token from ~/.sfdt/bridge-token,
 * comparing in constant time.
 *
 * @returns {import('express').RequestHandler}
 */
// Authorization-header limit. Real Bearer tokens are ~50 bytes; cap at 4 KB
// so a pathological header can't drive any string work in this hot path.
const MAX_AUTH_HEADER_BYTES = 4096;
const BEARER_PREFIX_RE = /^Bearer /i;

export function createBridgeAuthMiddleware() {
  return async (req, res, next) => {
    const header = req.get('Authorization') ?? '';
    // Manual prefix-and-slice instead of /^Bearer\s+(.+)$/i — the `\s+` over
    // attacker-controlled headers is a polynomial-ReDoS pattern flagged by
    // CodeQL. Match the prefix in one anchored shot, then slice and trim.
    let provided = null;
    if (header.length <= MAX_AUTH_HEADER_BYTES && BEARER_PREFIX_RE.test(header)) {
      provided = header.slice(7).trim() || null;
    }

    if (!provided) {
      return res.status(401).json({
        ok: false,
        error: 'Bearer token required',
        code: 'BRIDGE_UNAUTHORIZED',
      });
    }

    let expected;
    try {
      expected = await getOrCreateBridgeToken();
    } catch (err) {
      return res.status(500).json({
        ok: false,
        error: `Bridge token unavailable: ${err.message}`,
        code: 'INTERNAL_ERROR',
      });
    }

    if (!constantTimeEqual(provided, expected)) {
      return res.status(403).json({
        ok: false,
        error: 'Invalid bridge token',
        code: 'BRIDGE_UNAUTHORIZED',
      });
    }
    next();
  };
}
