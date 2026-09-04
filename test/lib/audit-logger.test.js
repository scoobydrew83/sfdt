import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';

// Mock fs-extra and config
vi.mock('fs-extra', () => {
  return {
    default: {
      ensureDir: vi.fn(),
      readJson: vi.fn(),
      outputJson: vi.fn(),
    },
  };
});

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    _configDir: '/fake/project/.sfdt',
    _projectRoot: '/fake/project',
    logDir: '/fake/project/logs',
  }),
}));

import fs from 'fs-extra';
import { redactSensitiveData, logAuditEvent } from '../../src/lib/audit-logger.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Audit Logger', () => {
  describe('redactSensitiveData', () => {
    it('redacts Salesforce access tokens starting with 00D', () => {
      const input = 'My token is 00D1A000000abcde and it is secret';
      const output = redactSensitiveData(input);
      expect(output).toBe('My token is [REDACTED_ACCESS_TOKEN] and it is secret');
    });

    it('redacts Salesforce user tokens starting with 005', () => {
      const input = 'My user token is 0051A000000xyz12';
      const output = redactSensitiveData(input);
      expect(output).toBe('My user token is [REDACTED_USER_TOKEN]');
    });

    it('redacts CLI password and client-secret flag values', () => {
      const cmd = 'sfdt deploy -u admin@company.org -p mysecretpassword123 --client-secret secretKeyABC';
      const output = redactSensitiveData(cmd);
      expect(output).toBe('sfdt deploy -u [REDACTED] -p [REDACTED] --client-secret [REDACTED]');
    });

    it('recursively redacts sensitive JSON keys in objects', () => {
      const payload = {
        projectName: 'Test Project',
        clientSecret: 'secret_123_abc',
        nested: {
          password: 'my-password',
          safeKey: 'hello',
        },
      };

      const output = redactSensitiveData(payload);

      expect(output.projectName).toBe('Test Project');
      expect(output.clientSecret).toBe('[REDACTED]');
      expect(output.nested.password).toBe('[REDACTED]');
      expect(output.nested.safeKey).toBe('hello');
    });

    it('recursively redacts sensitive values inside arrays', () => {
      const array = ['normal string', '00D1234567890abc', { password: 'pass' }];
      const output = redactSensitiveData(array);

      expect(output[0]).toBe('normal string');
      expect(output[1]).toBe('[REDACTED_ACCESS_TOKEN]');
      expect(output[2].password).toBe('[REDACTED]');
    });

    it('drops prototype-polluting keys without polluting Object.prototype', () => {
      const payload = JSON.parse('{"__proto__": {"polluted": true}, "safeKey": "ok"}');
      const output = redactSensitiveData(payload);

      expect(output.safeKey).toBe('ok');
      expect(Object.prototype.hasOwnProperty.call(output, '__proto__')).toBe(false);
      expect(({}).polluted).toBeUndefined();
    });
  });

  describe('logAuditEvent', () => {
    it('appends and caps log entries in logs/audit.json', async () => {
      // Mock existing logs
      const existing = Array.from({ length: 1005 }, (_, i) => ({
        timestamp: new Date().toISOString(),
        action: `old-action-${i}`,
        status: 'success',
        actor: 'CLI Operator',
        metadata: {},
      }));

      fs.readJson.mockResolvedValueOnce(existing);
      fs.ensureDir.mockResolvedValueOnce(undefined);
      fs.outputJson.mockResolvedValueOnce(undefined);

      await logAuditEvent('new-action', { someToken: '00D12000000abcd' });

      expect(fs.ensureDir).toHaveBeenCalledWith('/fake/project/logs');
      expect(fs.outputJson).toHaveBeenCalled();
      
      const loggedArray = fs.outputJson.mock.calls[0][1];
      // Caps at 1000 items
      expect(loggedArray).toHaveLength(1000);
      
      // Newest is at index 0 and has redacted metadata
      expect(loggedArray[0].action).toBe('new-action');
      expect(loggedArray[0].metadata.someToken).toBe('[REDACTED_ACCESS_TOKEN]');
    });
  });
});

// Secrets that arrive as FREE TEXT rather than a known token shape or a JSON
// key. Diffs, log excerpts, and error messages all pass through redaction on
// their way to an AI provider, a webhook, or the audit log — the token/key
// patterns never saw these.
describe('redactSensitiveData — free-text secrets', () => {
  it('redacts a PEM private key block', () => {
    const key = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nzzz\n-----END RSA PRIVATE KEY-----';
    const out = redactSensitiveData(`jwt failed with key:\n${key}\nend`);
    expect(out).toContain('[REDACTED_PRIVATE_KEY]');
    expect(out).not.toContain('MIIEowIBAAKCAQEA');
  });

  it('redacts a generic PRIVATE KEY block regardless of algorithm label', () => {
    const out = redactSensitiveData('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    expect(out).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('redacts an sfdx auth URL — a complete replayable org credential', () => {
    const out = redactSensitiveData('force://PlatformCLI::5Aep8abcdef@my-org.my.salesforce.com');
    expect(out).toBe('[REDACTED_SFDX_AUTH_URL]');
  });

  it('redacts a Bearer token but keeps the scheme readable', () => {
    const out = redactSensitiveData('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef');
    expect(out).toBe('Authorization: Bearer [REDACTED]');
  });

  it('redacts secret-ish assignments in prose, preserving the key name', () => {
    const out = redactSensitiveData('failed: api_key=abc123secret, password: hunter2xyz');
    expect(out).toContain('api_key=[REDACTED]');
    expect(out).toContain('password: [REDACTED]');
    expect(out).not.toContain('abc123secret');
    expect(out).not.toContain('hunter2xyz');
  });

  it('preserves the quoting style of a redacted assignment', () => {
    expect(redactSensitiveData('token: "abcd1234"')).toBe('token: "[REDACTED]"');
  });

  // False positives matter as much as coverage — over-redaction destroys the
  // diagnostic value of the logs and prompts this feeds.
  it('does not redact an env-var NAME reference like apiKeyEnv', () => {
    const s = 'set apiKeyEnv: "OPENROUTER_KEY" in config';
    expect(redactSensitiveData(s)).toBe(s);
  });

  it('does not redact prose that merely mentions a secret-ish word', () => {
    const s = 'the deployment token flow requires review';
    expect(redactSensitiveData(s)).toBe(s);
  });

  it('does not redact an empty or structural value', () => {
    const s = 'token: {} and password = ';
    expect(redactSensitiveData(s)).toBe(s);
  });

  it('still redacts the Salesforce token shapes it always did', () => {
    expect(redactSensitiveData('session 00D5f000000abcdEAA')).toContain('[REDACTED_ACCESS_TOKEN]');
  });

  it('applies to strings nested in objects and arrays', () => {
    const out = redactSensitiveData({ findings: ['auth is force://a::b@c.example'] });
    expect(out.findings[0]).toBe('auth is [REDACTED_SFDX_AUTH_URL]');
  });
});

describe('session-id redaction covers the secret half (v0.24.0 security gate, H2)', () => {
  // A Salesforce session id is `<entityId>!<secret>`. The patterns used to end at
  // `\b`, which stops at the `!`: they redacted the *public* id and left the
  // credential in place. Worse, the replacement text inserts `[`/`]`, which fall
  // outside BEARER_RE's character class — so the partial rule prevented the
  // working rule from ever firing on the same token.
  // Assembled at runtime, never written as one literal. These fixtures have to
  // *match* the real token shapes to exercise the patterns, which is exactly what
  // GitHub push protection scans for — a literal here blocks the push (it did).
  // Concatenation keeps the shape at runtime without a scannable literal in source.
  const SECRET = ['AQoAQ', 'NOT', 'AREAL', 'TOKEN', 'x'.repeat(30)].join('');
  const ORG_ID = '00D' + '5g0000049abcEAA'.replace('abc', 'xxx');
  const USER_ID = '005' + '5g00000AbCdEfAA'.replace('AbC', 'xxx');

  it.each([
    ['bearer header',   () => `Authorization: Bearer ${ORG_ID}!${SECRET}`],
    ['json field',      () => `{"sessionId":"${ORG_ID}!${SECRET}"}`],
    ['xml element',     () => `<sessionId>${ORG_ID}!${SECRET}</sessionId>`],
    ['user-id form',    () => `sid=${USER_ID}!${SECRET}`],
    ['bare in prose',   () => `login failed for ${ORG_ID}!${SECRET} at 12:04`],
  ])('never leaks the secret half — %s', (_label, build) => {
    expect(redactSensitiveData(build())).not.toContain(SECRET);
  });

  it('still redacts a bare entity id with no secret attached', () => {
    expect(redactSensitiveData(`org is ${ORG_ID}`)).toBe('org is [REDACTED_ACCESS_TOKEN]');
    expect(redactSensitiveData(`org is ${ORG_ID.slice(0, 15)}`)).toBe('org is [REDACTED_ACCESS_TOKEN]');
  });

  it('redacts refresh tokens whose 5th character is not the literal D', () => {
    // The pattern hardcoded `5AepD`, matching one org's tokens and passing
    // every other org's through untouched. Both shapes assembled, not literal.
    const tail = 'NOTAREALTOKEN' + 'y'.repeat(30);
    const t = '5Aep' + '8' + tail;   // 5th char is not D — previously missed
    expect(redactSensitiveData(`refresh_token ${t}`)).not.toContain(t);
    const d = '5Aep' + 'D' + tail;   // the one shape the old pattern caught
    expect(redactSensitiveData(`refresh_token ${d}`)).not.toContain(d);
  });
});
