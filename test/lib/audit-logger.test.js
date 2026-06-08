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
