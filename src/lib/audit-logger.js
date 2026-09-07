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
// The body is BOUNDED. An unbounded `[\s\S]*?` does not stop at any structural
// boundary, so two BEGIN/END-shaped lines anywhere in the same string swallow
// everything between them — and because the result is still well-formed text (or
// still-valid JSON), the deletion is silent. Reproduced on a parked Apex log: six
// lines became three, and on a serialized SOQL result: eight records became three,
// handed to the model as complete. That is an evasion primitive against the very
// scanning these tools perform, so the fix belongs here rather than at each caller.
//
// The body is also constrained to what a PEM body actually is: base64 plus
// whitespace. That is the real discriminator — bounding the length alone does not
// help, because arbitrary content *closer together* than the bound is still
// swallowed. Log lines and JSON carry `:` `,` `"` `{`, none of which are base64,
// so they can no longer sit inside a match. 8000 comfortably exceeds any real key
// (RSA-4096 armours to ~3.2 kB).
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]{0,8000}?-----END [A-Z ]*PRIVATE KEY-----/g;

// sfdx auth URL — a complete, replayable org credential in a single string.
// `sf org display --verbose` prints these, and that output lands in logs.
const SFDX_AUTH_URL_RE = /force:\/\/[^\s"']+/g;

// `Authorization: Bearer <token>` as it appears in a captured request or a
// curl line. Keeps the scheme so the redaction is readable in context.
// `Basic` too: a base64 `user:password` is every bit as replayable, and the same
// captured-request text carries it.
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/-]{12,}={0,2}/gi;

// `Basic <base64(user:password)>` is every bit as replayable, but the scheme word is also an
// ordinary English adjective — a bare `Basic\s+\w{12,}` turned "Basic authentication
// required" into "Basic [REDACTED] required", corrupting prose on its way to the model and
// into the audit trail. The lookahead demands the token actually look like base64 (at least
// one digit, `+`, `/` or `=`), which no English word satisfies.
const BASIC_AUTH_RE = /\b(Basic)\s+(?=[A-Za-z0-9+/]*[0-9+/=])[A-Za-z0-9+/]{12,}={0,2}/g;

// key=value / key: value for secret-ish names in prose. The `\b` after the name
// matters: it keeps `apiKeyEnv: "MY_VAR"` (a variable NAME, not a secret) from
// being redacted, while still catching `api_key: abc123`.
//
// The separator has to survive SERIALIZATION, not just prose. Every AI path redacts the
// assembled prompt *string* (ai.js), so this pattern — not the key-based object branch
// below — is what actually runs on payloads. A bare `[:=]` only ever matched the prose
// form: in JSON the next character after the name is a closing quote (`"password":"x"`)
// and in XML it is `>` (`<password>x</password>`), so the two most common serializations
// of a secret passed through verbatim. The optional quote before the separator and the
// `>` in its class close both. `<` and `>` are excluded from the value so an XML match
// stops at the closing tag instead of swallowing it.
const SECRET_NAMES =
  'password|passwd|secret|client[_-]?secret|consumer[_-]?secret|api[_-]?key|apikey|' +
  'authorization|token|access[_-]?token|refresh[_-]?token|private[_-]?key';

// Three shapes, three groups of alternatives:
//
//  - The leading `(?<![A-Za-z0-9])` replaces a plain `\b`. `\b` does not fire between `_` and
//    a letter, so `SF_PASSWORD=...` — and every other env-var spelling — was passed through
//    verbatim. Golden principle #4 makes env vars the canonical secret channel here, so an
//    `env` dump or a `sf` error echoing one is exactly the text that reaches a provider. The
//    lookbehind still refuses a match inside a word like `mypassword`.
//  - A QUOTED value runs lazily to its matching quote, so spaces, commas, semicolons and
//    braces inside it no longer end the match early and leave the tail in the clear.
//  - A BARE value keeps the old conservative class, and `<`/`>` stay INSIDE it so
//    `password: <hunter2>` still redacts — 0.25.0 caught that and an earlier cut of this
//    change stopped catching it.
//
// The trailing `\b` after the name is what keeps `apiKeyEnv: "MY_VAR"` — a variable NAME, not
// a secret — readable. That inverse matters as much as the redaction itself.
//
// `authorization` IS included, guarded by a scheme lookahead: its value is
// `<scheme> <credential>`, so an unguarded match would redact the scheme and leave the
// credential beside it. BEARER_RE / BASIC_AUTH_RE handle those two properly and run first;
// this catches the schemeless remainder (`Authorization: sk-ant-...`).
const SECRET_ASSIGNMENT_RE = new RegExp(
  `(?<![A-Za-z0-9])(${SECRET_NAMES})\\b` +
    '(["\']?\\s*[:=]\\s*)' +
    '(?:(["\'])((?:(?!\\3)[^\\r\\n]){4,}?)\\3|(?!Bearer\\b|Basic\\b)([^\\s"\',;}]{4,}))',
  'gi',
);

// XML/HTML element form, which the assignment pattern cannot express: the separator is `>`
// and the value ends at `<`. Putting `>` into the assignment separator instead was a mistake
// — it also matched the `>` of a CLOSING tag and of a comparison, so `</token> hardcoded`
// silently deleted the following word. That is the same silent-deletion evasion primitive
// PRIVATE_KEY_BLOCK_RE above documents, pointed at prose. Attributes are preserved so the
// surrounding document still parses.
const SECRET_ELEMENT_RE = new RegExp(
  `<(${SECRET_NAMES})\\b([^>]*)>([^<]{4,})<\\/\\1(\\s*)>`,
  'gi',
);

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
  // Keys are normalised with `.replace(/[^a-z]/g, '')` before lookup, so these entries are
  // the letters-only forms: `x-api-key` arrives as `xapikey`, `Consumer Secret` as
  // `consumersecret`. The list had no api-key, authorization, consumer-secret or
  // private-key entry at all, so an object carrying any of them under its own name was
  // returned verbatim even on the paths where this branch does run.
  'apikey',
  'xapikey',
  'authorization',
  'consumersecret',
  'privatekey',
  'passwd',
  'sfdxauthurl',
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
    redacted = redacted.replace(BASIC_AUTH_RE, '$1 [REDACTED]');
    redacted = redacted.replace(SECRET_ELEMENT_RE, '<$1$2>[REDACTED]</$1$4>');
    redacted = redacted.replace(
      SECRET_ASSIGNMENT_RE,
      // Quoted and bare values are separate alternatives, so exactly one of `quoted`/`bare`
      // is defined. Re-emitting the quotes keeps JSON and YAML valid after redaction.
      // `_bare` is the bare-value alternative; unused because that branch needs no quotes
      // re-emitted, but named so the group positions stay readable against the pattern.
      (match, key, sep, quote, quoted, _bare) =>
        quoted !== undefined
          ? `${key}${sep}${quote}[REDACTED]${quote}`
          : `${key}${sep}[REDACTED]`,
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
