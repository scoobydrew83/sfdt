import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from './config.js';

const MAX_AUDIT_LOG_ENTRIES = 1000;

// Salesforce session id / access token. The wire format is `<entityId>!<secret>`
// — the id half is public, the secret half is the credential. An earlier version
// of these patterns ended at `\b`, which stops at the `!`: it redacted the public
// id and left the secret in place. Worse, it substituted `[`/`]` into the string,
// and those fall outside BEARER_RE's character class below — so the partial rule
// *prevented* the working rule from firing on the same token. The `!secret` tail
// is therefore part of the match, and optional so a bare id still redacts.
const SESSION_SECRET_TAIL = '(?:![^\\s"\'`<>]+)?';
const ACCESS_TOKEN_RE = new RegExp(`\\b(00D[a-zA-Z0-9]{12,})${SESSION_SECRET_TAIL}`, 'g');
const ACCESS_TOKEN_USER_RE = new RegExp(`\\b(005[a-zA-Z0-9]{12,})${SESSION_SECRET_TAIL}`, 'g');
// Refresh tokens carry the `5Aep` prefix; the character after it varies by org and
// is not part of the format. Hardcoding a literal `D` there matched one org's
// tokens and passed every other org's through untouched.
const REFRESH_TOKEN_RE = /\b(5Aep[a-zA-Z0-9]{20,})\b/g;

// CLI arguments pattern: redact password, client-secret, and token flags
const SENSITIVE_CLI_ARGS_RE = /(-p|--password|--client-secret|--access-token|-u|--username)\s+([^\s]+)/gi;

// The patterns below cover secrets that appear as *free text* rather than as a
// known token shape or a JSON key — diffs, log excerpts, error messages, and
// stack traces all flow through here on their way to an AI provider, a webhook,
// or the audit log. The token/key patterns above never saw them.

// PEM private key blocks. The header comment above has always claimed these
// were handled; no pattern existed. A JWT signing key pasted into a log or a
// deploy error was passed through verbatim.
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// sfdx auth URL — a complete, replayable org credential in a single string.
// `sf org display --verbose` prints these, and that output lands in logs.
const SFDX_AUTH_URL_RE = /force:\/\/[^\s"']+/g;

// `Authorization: Bearer <token>` as it appears in a captured request or a
// curl line. Keeps the scheme so the redaction is readable in context.
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;

// key=value / key: value for secret-ish names in prose. The `\b` after the name
// matters: it keeps `apiKeyEnv: "MY_VAR"` (a variable NAME, not a secret) from
// being redacted, while still catching `api_key: abc123`.
const SECRET_ASSIGNMENT_RE =
  /\b(password|passwd|secret|client[_-]?secret|api[_-]?key|apikey|token|access[_-]?token|refresh[_-]?token|private[_-]?key)\b(\s*[:=]\s*)(["']?)([^\s"',;}]{4,})\3/gi;

// JSON keys that should have their values redacted
const SENSITIVE_KEYS = [
  'password',
  'clientsecret',
  'client_secret',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'token',
  // A Salesforce session id IS a bearer token. `sfdt events tail` holds one in
  // memory to run a CometD long-poll (see org-session.js), so the names it
  // could plausibly travel under are redacted here too. This is the backstop —
  // the plan is that it never reaches a log at all.
  'sessionid',
  'session_id',
  'sid',
];

/**
 * Recursively redacts sensitive patterns in strings, arrays, and objects.
 *
 * @param {any} value
 * @returns {any}
 */
export function redactSensitiveData(value) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    let redacted = value;
    // 1. Redact access tokens
    redacted = redacted.replace(ACCESS_TOKEN_RE, '[REDACTED_ACCESS_TOKEN]');
    redacted = redacted.replace(ACCESS_TOKEN_USER_RE, '[REDACTED_USER_TOKEN]');
    redacted = redacted.replace(REFRESH_TOKEN_RE, '[REDACTED_REFRESH_TOKEN]');

    // 2. Redact command-line arguments
    redacted = redacted.replace(SENSITIVE_CLI_ARGS_RE, (match, flag) => {
      return `${flag} [REDACTED]`;
    });

    // 3. Redact secrets that appear as free text. Private-key blocks run first
    //    so the multi-line match isn't chewed up by the single-line patterns.
    redacted = redacted.replace(PRIVATE_KEY_BLOCK_RE, '[REDACTED_PRIVATE_KEY]');
    redacted = redacted.replace(SFDX_AUTH_URL_RE, '[REDACTED_SFDX_AUTH_URL]');
    redacted = redacted.replace(BEARER_RE, '$1 [REDACTED]');
    redacted = redacted.replace(
      SECRET_ASSIGNMENT_RE,
      (match, key, sep, quote) => `${key}${sep}${quote}[REDACTED]${quote}`,
    );

    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item));
  }

  if (typeof value === 'object') {
    // Build via fromEntries (no dynamic bracket-writes) so untrusted keys can
    // never be used as a property-write sink. Prototype-polluting keys are
    // dropped, and sensitive keys are redacted.
    const entries = Object.keys(value)
      .filter((key) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
      .map((key) => {
        const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '');
        const redactedValue = SENSITIVE_KEYS.includes(lowerKey)
          ? '[REDACTED]'
          : redactSensitiveData(value[key]);
        return [key, redactedValue];
      });
    return Object.fromEntries(entries);
  }

  return value;
}

/**
 * Appends a structured audit event to the project's local audit trail.
 *
 * @param {string} action - Action name (e.g. 'deploy', 'rollback', 'config-set')
 * @param {object} [metadata] - Contextual metadata associated with the action
 * @param {object} [context] - Context variables like user/actor or IP address
 * @returns {Promise<void>}
 */
export async function logAuditEvent(action, metadata = {}, context = {}) {
  try {
    let config = null;
    try {
      config = await loadConfig();
    } catch {
      // Ignore
    }
    if (!config?._configDir) return; // Not in a configured sfdt project

    const logDir = config.logDir ?? path.join(config._projectRoot, 'logs');
    const auditFilePath = path.join(logDir, 'audit.json');

    await fs.ensureDir(logDir);
    let existingLogs = await fs.readJson(auditFilePath).catch(() => []);
    if (!Array.isArray(existingLogs)) {
      existingLogs = [];
    }

    const newEntry = {
      timestamp: new Date().toISOString(),
      action,
      status: context.status ?? 'success',
      actor: context.actor ?? 'CLI Operator',
      ip: context.ip ?? null,
      metadata: redactSensitiveData(metadata),
    };

    existingLogs.unshift(newEntry);
    
    // Enforce history size limit
    const cappedLogs = existingLogs.slice(0, MAX_AUDIT_LOG_ENTRIES);
    await fs.outputJson(auditFilePath, cappedLogs, { spaces: 2 });
  } catch (err) {
    // Fail silently to avoid breaking execution if logging directory is read-only
    console.error(`Audit logging failed: ${err.message}`);
  }
}
