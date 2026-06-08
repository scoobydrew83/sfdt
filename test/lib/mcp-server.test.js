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
});
