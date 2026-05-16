import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
export function createRateLimiter(maxRequests = 60, windowMs = 60_000) {
  return rateLimit({ windowMs, limit: maxRequests, standardHeaders: true, legacyHeaders: false });
}
export function createOriginGuard(port) {
  const allowed = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);
  return (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !allowed.has(origin)) {
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
  if (!provided || provided !== token) {
    res.status(403).json({ error: 'Forbidden' });
    return false;
  }
  return true;
}
