import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRegisteredHandlers = new Map();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => {
  class MockServer {
    constructor(info, options) {
      this.info = info;
      this.options = options;
    }
    setRequestHandler(schema, handler) {
      mockRegisteredHandlers.set(schema, handler);
    }
    async connect(transport) {
      this.transport = transport;
    }
  }
  return {
    Server: MockServer,
  };
});

vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'call-tool',
  ListToolsRequestSchema: 'list-tools',
}));

vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'mock stdout', stderr: '' }),
}));

vi.mock('fs-extra', () => ({
  default: {
    pathExists: vi.fn().mockResolvedValue(true),
    readJson: vi.fn().mockResolvedValue({ latest: 'json' }),
    readdir: vi.fn().mockResolvedValue([]),
  },
}));

vi.mock('../../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    projectName: 'Test Project',
    defaultOrg: 'dev',
    logDir: '/project/logs',
  }),
}));

vi.mock('../../src/lib/mcp-parking.js', () => ({
  parkIfNeeded: vi.fn().mockImplementation((val) => val),
  getParkedResult: vi.fn().mockResolvedValue({ parked: 'data' }),
}));

import { execa } from 'execa';
import fs from 'fs-extra';
import { SfdtMcpServer } from '../../src/lib/mcp-server.js';
import { parkIfNeeded, getParkedResult } from '../../src/lib/mcp-parking.js';

describe('SfdtMcpServer', () => {
  let mcpServer;

  beforeEach(async () => {
    mockRegisteredHandlers.clear();
    vi.clearAllMocks();
    mcpServer = new SfdtMcpServer();
    await mcpServer.start();
  });

  it('registers handlers and connects on start', () => {
    expect(mockRegisteredHandlers.has('list-tools')).toBe(true);
    expect(mockRegisteredHandlers.has('call-tool')).toBe(true);
  });

  it('handles list-tools request', async () => {
    const handler = mockRegisteredHandlers.get('list-tools');
    const result = await handler({});
    expect(result.tools).toBeDefined();
    expect(result.tools.some((t) => t.name === 'sfdt_preflight')).toBe(true);
    // SEP-2549 cache metadata: catalog is static, so long TTL + global scope
    expect(result.ttlMs).toBe(86_400_000);
    expect(result.cacheScope).toBe('global');
  });

  describe('call-tool actions', () => {
    let callHandler;

    beforeEach(() => {
      callHandler = mockRegisteredHandlers.get('call-tool');
    });

    const callTool = (name, args = {}) => {
      return callHandler({ params: { name, arguments: args } });
    };

    it('executes sfdt_preflight tool', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'preflight pass', stderr: '' });

      const result = await callTool('sfdt_preflight', { strict: true });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['preflight', '--strict']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('preflight pass');
    });

    it('executes sfdt_drift tool', async () => {
      const payload = { driftStatus: 'PASS' };
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' });

      const result = await callTool('sfdt_drift', { org: 'prod' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['drift', '--org', 'prod']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('driftStatus');
    });

    it('executes sfdt_coverage (read-only, --json, optional org)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ orgWide: 82 }), stderr: '' });

      const result = await callTool('sfdt_coverage', { org: 'prod' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['coverage', '--json', '--org', 'prod']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('orgWide');
    });

    it('executes sfdt_scan (read-only metadata inventory)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ types: [] }), stderr: '' });

      await callTool('sfdt_scan', {});
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['scan', '--json']),
        expect.anything()
      );
    });

    it('executes sfdt_dependencies with the required component name', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ references: [] }), stderr: '' });

      await callTool('sfdt_dependencies', { name: 'MyClass', org: 'dev' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['dependencies', 'MyClass', '--json', '--org', 'dev']),
        expect.anything()
      );
    });

    it('executes sfdt_flow_scan and threads the optional org (flow scan queries the org)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ flows: [] }), stderr: '' });

      await callTool('sfdt_flow_scan', { org: 'dev' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['flow', 'scan', '--json', '--org', 'dev']),
        expect.anything()
      );
    });

    it('executes sfdt_flow_scan without org (falls back to config defaultOrg)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ flows: [] }), stderr: '' });

      await callTool('sfdt_flow_scan', {});
      const call = execa.mock.calls.at(-1);
      expect(call[1]).toContain('flow');
      expect(call[1]).not.toContain('--org');
    });

    it('executes sfdt_history and threads type + limit', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ result: { runs: [], count: 0 } }), stderr: '' });

      await callTool('sfdt_history', { type: 'audit', limit: 10 });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['history', '--json', '--type', 'audit', '--limit', '10']),
        expect.anything()
      );
    });

    it('executes sfdt_validate as a dry-run deploy (passes --dry-run)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'validated', stderr: '' });

      const result = await callTool('sfdt_validate', { targetOrg: 'prod' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['deploy', '--dry-run']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('validated');
    });

    it('executes sfdt_compare tool and returns latest log when successful', async () => {
      fs.pathExists.mockResolvedValueOnce(true);
      fs.readJson.mockResolvedValueOnce({ compare: 'diff' });
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      const result = await callTool('sfdt_compare', { source: 'local', target: 'dev' });
      expect(fs.pathExists).toHaveBeenCalledWith(expect.stringContaining('compare-latest.json'));
      expect(result.content[0].text).toContain('compare');
    });

    it('executes sfdt_quality tool and returns quality logs', async () => {
      fs.pathExists.mockResolvedValueOnce(true);
      fs.readJson.mockResolvedValueOnce({ quality: 'score' });
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

      const result = await callTool('sfdt_quality', { fixPlan: true, generateStubs: true });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['quality', '--generate-stubs', '--fix-plan']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('quality');
    });

    it('executes sfdt_logs tool for preflight', async () => {
      fs.pathExists.mockResolvedValueOnce(true);
      fs.readJson.mockResolvedValueOnce({ latestPreflight: true });

      const result = await callTool('sfdt_logs', { type: 'preflight' });
      expect(fs.readJson).toHaveBeenCalledWith(expect.stringContaining('preflight-latest.json'));
      expect(result.content[0].text).toContain('latestPreflight');
    });

    it('executes sfdt_logs tool for deploy archive history', async () => {
      fs.pathExists.mockResolvedValueOnce(true);
      fs.readdir.mockResolvedValueOnce(['deploy-1.json', 'deploy-2.json']);
      fs.readJson.mockResolvedValueOnce({ deployRun: 2 });

      const result = await callTool('sfdt_logs', { type: 'deploy' });
      expect(fs.readdir).toHaveBeenCalledWith(expect.stringContaining('deploy-results'));
      expect(fs.readJson).toHaveBeenCalledWith(expect.stringContaining('deploy-2.json'));
      expect(result.content[0].text).toContain('deployRun');
    });

    it('executes sfdt_audit tool with a single named check', async () => {
      const payload = { org: 'prod', summary: { ok: 6 } };
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' });

      const result = await callTool('sfdt_audit', { org: 'prod', check: 'mfa' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['audit', 'mfa', '--json', '--org', 'prod']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('summary');
    });

    it('defaults sfdt_audit to the "all" check', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });
      await callTool('sfdt_audit', {});
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['audit', 'all', '--json']), expect.anything());
    });

    it('executes sfdt_monitor with --backup when requested', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });
      await callTool('sfdt_monitor', { check: 'all', backup: true });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['monitor', 'all', '--json', '--backup']),
        expect.anything()
      );
    });

    it('executes sfdt_docs with --ai when requested', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ status: 'success', counts: {} }), stderr: '' });
      const result = await callTool('sfdt_docs', { ai: true });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['docs', 'generate', '--json', '--ai']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('success');
    });

    it('executes sfdt_manifest_from_git tool', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'manifest generated', stderr: '' });

      const result = await callTool('sfdt_manifest_from_git', { base: 'main', head: 'HEAD', package: 'all' });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['manifest', '--base', 'main', '--head', 'HEAD', '--package', 'all']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('manifest generated');
    });

    it('executes sfdt_validate tool', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'validation ok', stderr: '' });

      const result = await callTool('sfdt_validate', {
        targetOrg: 'dev',
        manifest: 'manifest/package.xml',
        testLevel: 'RunLocalTests',
      });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['deploy']),
        expect.objectContaining({
          env: expect.objectContaining({
            SFDT_DRY_RUN: 'true',
            SFDT_TARGET_ORG: 'dev',
            SFDT_TEST_LEVEL: 'RunLocalTests',
          }),
        })
      );
      expect(result.content[0].text).toContain('validation ok');
    });

    it('executes sfdt_deploy tool and throws if confirmExecution is not true', async () => {
      const result = await callTool('sfdt_deploy', { targetOrg: 'dev' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmExecution');
    });

    it('executes sfdt_deploy tool when confirmExecution is true', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'deployed', stderr: '' });

      const result = await callTool('sfdt_deploy', {
        targetOrg: 'dev',
        confirmExecution: true,
        testClasses: ['TestA', 'TestB'],
      });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['deploy']),
        expect.objectContaining({
          env: expect.objectContaining({
            SFDT_DRY_RUN: 'false',
            SFDT_SPECIFIED_TESTS: 'TestA TestB',
          }),
        })
      );
      expect(result.content[0].text).toContain('deployed');
    });

    it('gates the mutating tools behind confirmExecution', async () => {
      for (const [name, args] of [
        ['sfdt_release', {}],
        ['sfdt_scratch_create', {}],
        ['sfdt_scratch_delete', { target: 'sc1' }],
        ['sfdt_scratch_pool', { action: 'fill' }],
        ['sfdt_data_import', { set: 'accounts' }],
        ['sfdt_data_delete', { set: 'accounts' }],
      ]) {
        const result = await callTool(name, args);
        expect(result.isError, name).toBe(true);
        expect(result.content[0].text, name).toContain('confirmExecution');
      }
    });

    it('runs sfdt_release when confirmed', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'released', stderr: '' });
      await callTool('sfdt_release', { version: '1.2.0', package: 'all', confirmExecution: true });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['release', '1.2.0', '--package', 'all']), expect.anything());
    });

    it('runs sfdt_scratch_create/delete with --json/--yes when confirmed', async () => {
      execa.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ result: { ok: true } }), stderr: '' });
      await callTool('sfdt_scratch_create', { alias: 'dev1', days: 7, confirmExecution: true });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['scratch', 'create', '--json', '--alias', 'dev1', '--days', '7']), expect.anything());
      await callTool('sfdt_scratch_delete', { target: 'dev1', confirmExecution: true });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['scratch', 'delete', 'dev1', '--yes', '--json']), expect.anything());
    });

    it('sfdt_scratch_pool status is read-only (no confirmExecution needed)', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ result: { size: 3 } }), stderr: '' });
      const result = await callTool('sfdt_scratch_pool', { action: 'status' });
      expect(result.isError).toBeFalsy();
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['scratch', 'pool', 'status', '--json']), expect.anything());
    });

    it('sfdt_data_export is read-only; import/delete pass --json/--yes when confirmed', async () => {
      execa.mockResolvedValue({ exitCode: 0, stdout: JSON.stringify({ result: { ok: true } }), stderr: '' });
      await callTool('sfdt_data_export', { set: 'accounts', org: 'dev' });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['data', 'export', 'accounts', '--json', '--org', 'dev']), expect.anything());
      await callTool('sfdt_data_delete', { set: 'accounts', confirmExecution: true });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['data', 'delete', 'accounts', '--yes', '--json']), expect.anything());
    });

    it('runs sfdt_test with --class-names', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'tests passed', stderr: '' });
      await callTool('sfdt_test', { classNames: ['A_Test', 'B_Test'] });
      expect(execa).toHaveBeenCalledWith('node', expect.arrayContaining(['test', '--class-names', 'A_Test,B_Test']), expect.anything());
    });

    it('executes sfdt_quick_deploy tool and throws if confirmExecution is not true', async () => {
      const result = await callTool('sfdt_quick_deploy', { targetOrg: 'dev', validationJobId: '0Af123' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmExecution');
    });

    it('executes sfdt_quick_deploy tool when confirmExecution is true', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'quick deploy complete', stderr: '' });

      const result = await callTool('sfdt_quick_deploy', {
        targetOrg: 'dev',
        validationJobId: '0Af123',
        confirmExecution: true,
      });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['deploy']),
        expect.objectContaining({
          env: expect.objectContaining({
            SFDT_VALIDATION_JOB_ID: '0Af123',
          }),
        })
      );
      expect(result.content[0].text).toContain('quick deploy complete');
    });

    it('executes sfdt_rollback tool and throws if confirmExecution is not true', async () => {
      const result = await callTool('sfdt_rollback', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('confirmExecution');
    });

    it('executes sfdt_rollback tool when confirmExecution is true', async () => {
      const payload = { rollbackStatus: 'SUCCESS' };
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' });

      const result = await callTool('sfdt_rollback', { confirmExecution: true });
      expect(execa).toHaveBeenCalledWith(
        'node',
        expect.arrayContaining(['rollback', '--json']),
        expect.anything()
      );
      expect(result.content[0].text).toContain('rollbackStatus');
    });

    it('executes sfdt_get_parked_result tool', async () => {
      const result = await callTool('sfdt_get_parked_result', { ref: 'parked://uuid' });
      expect(getParkedResult).toHaveBeenCalledWith('parked://uuid', expect.anything());
      expect(result.content[0].text).toContain('parked');
    });

    it('handles unknown tool call gracefully', async () => {
      const result = await callTool('non_existent_tool', {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });
  });

  describe('W3C trace context', () => {
    const VALID_TRACEPARENT = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-01`;
    let callHandler;

    beforeEach(() => {
      callHandler = mockRegisteredHandlers.get('call-tool');
    });

    it('echoes traceparent and tracestate in result _meta on success', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });

      const result = await callHandler({
        params: {
          name: 'sfdt_preflight',
          arguments: {},
          _meta: { traceparent: VALID_TRACEPARENT, tracestate: 'vendor=x' },
        },
      });
      expect(result._meta).toEqual({ traceparent: VALID_TRACEPARENT, tracestate: 'vendor=x' });
    });

    it('echoes trace context on the error path', async () => {
      const result = await callHandler({
        params: {
          name: 'non_existent_tool',
          arguments: {},
          _meta: { traceparent: VALID_TRACEPARENT },
        },
      });
      expect(result.isError).toBe(true);
      expect(result._meta).toEqual({ traceparent: VALID_TRACEPARENT });
    });

    it('treats a malformed traceparent as absent', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await callHandler({
        params: {
          name: 'sfdt_preflight',
          arguments: {},
          _meta: { traceparent: 'not-a-trace; rm -rf /' },
        },
      });
      expect(result._meta).toBeUndefined();
      const logged = errorSpy.mock.calls.flat().join(' ');
      expect(logged).not.toContain('not-a-trace');
      errorSpy.mockRestore();
    });

    it('omits _meta when no trace context is provided', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });

      const result = await callHandler({ params: { name: 'sfdt_preflight', arguments: {} } });
      expect(result._meta).toBeUndefined();
    });
  });

  describe('argument log redaction', () => {
    it('logs arg keys but never arg values', async () => {
      execa.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const callHandler = mockRegisteredHandlers.get('call-tool');
      await callHandler({
        params: { name: 'sfdt_validate', arguments: { targetOrg: 'SENTINEL-secret-org' } },
      });

      const logged = errorSpy.mock.calls.flat().join(' ');
      expect(logged).toContain('targetOrg');
      expect(logged).not.toContain('SENTINEL-secret-org');
      errorSpy.mockRestore();
    });
  });
});
