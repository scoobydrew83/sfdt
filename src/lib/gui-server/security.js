import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import { constantTimeEqual } from '../bridge/token.js';

export function createRateLimiter(maxRequests = 60, windowMs = 60_000) {
  return rateLimit({ windowMs, limit: maxRequests, standardHeaders: true, legacyHeaders: false });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function createOriginGuard(port) {
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      if (!allowed.has(origin)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    } else if (!SAFE_METHODS.has(req.method)) {
      // Non-browser clients (curl, native apps) and stripped-Origin edge cases
      // cannot drive mutating endpoints. Browsers always send Origin on
      // cross-origin POST/PATCH/DELETE.
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

export function createCsrfToken() {
  return crypto.randomBytes(32).toString('base64url');
}

export function requireCsrfToken(req, res, token) {
  const provided = req.get('x-sfdt-csrf');
  // constantTimeEqual handles non-string / empty input by returning false, so
  // we don't need a separate `!provided` short-circuit (which would leak
  // presence-vs-mismatch timing).
  if (!constantTimeEqual(provided, token)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}

/**
 * CSRF check variant for endpoints that cannot send custom headers — notably
 * EventSource (SSE), which only supports query strings. Accepts the token
 * from `?csrf=...` or the `x-sfdt-csrf` header. Constant-time comparison
 * via constantTimeEqual so a partial match cannot be timed.
 */
export function requireCsrfTokenFromQueryOrHeader(req, res, token) {
  const provided = req.get('x-sfdt-csrf') || (typeof req.query?.csrf === 'string' ? req.query.csrf : '');
  if (!constantTimeEqual(provided, token)) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}
