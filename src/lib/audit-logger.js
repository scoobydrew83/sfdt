import fs from 'fs-extra';
import path from 'path';
import { loadConfig } from './config.js';

const MAX_AUDIT_LOG_ENTRIES = 1000;

// Access token pattern: standard Salesforce Session ID / access token (starts with 00D, etc.)
// 15 or 18 alphanumeric characters. Also handles generic refresh tokens, private keys.
const ACCESS_TOKEN_RE = /\b(00D[a-zA-Z0-9]{12,15})\b/g;
const ACCESS_TOKEN_USER_RE = /\b(005[a-zA-Z0-9]{12,15})\b/g;
const REFRESH_TOKEN_RE = /\b(5AepD[a-zA-Z0-9]{20,})\b/g;

// CLI arguments pattern: redact password, client-secret, and token flags
const SENSITIVE_CLI_ARGS_RE = /(-p|--password|--client-secret|--access-token|-u|--username)\s+([^\s]+)/gi;

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

    return redacted;
  }

  if (Array.isArray(value)) {
    return value.map(item => redactSensitiveData(item));
  }

  if (typeof value === 'object') {
    const redactedObj = {};
    for (const key of Object.keys(value)) {
      const lowerKey = key.toLowerCase().replace(/[^a-z]/g, '');
      if (SENSITIVE_KEYS.includes(lowerKey)) {
        redactedObj[key] = '[REDACTED]';
      } else {
        redactedObj[key] = redactSensitiveData(value[key]);
      }
    }
    return redactedObj;
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
