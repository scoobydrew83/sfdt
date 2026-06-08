import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import fs from 'fs-extra';
import { createGuiApp, startGuiServer } from '../../src/lib/gui-server/index.js';

vi.mock('../../src/lib/ai.js', () => ({
  isAiAvailable: vi.fn().mockResolvedValue(true),
  streamAiResponse: vi.fn().mockImplementation(async (messages, systemPrompt, options, onChunk, onProc) => {
    onChunk('mock chunk');
    return { exitCode: 0 };
  }),
}));

const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockGetDevOpsCenterContext = vi.fn().mockResolvedValue({
  pipeline: { stages: [] },
  workItems: { items: [] },
});

class MockSalesforceMcpClient {
  constructor(config) {
    this.config = config;
  }
  async getDevOpsCenterContext() {
    return mockGetDevOpsCenterContext();
  }
  async disconnect() {
    return mockDisconnect();
  }
}

vi.mock('../../src/lib/mcp-client.js', () => ({
  SalesforceMcpClient: MockSalesforceMcpClient,
}));

vi.mock('fs-extra', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    pathExists: vi.fn().mockResolvedValue(false),
    readJson: vi.fn().mockResolvedValue({}),
    readdir: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue(''),
    outputJson: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ mtime: new Date(), size: 0 }),
    remove: vi.fn().mockResolvedValue(undefined),
    ensureDir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined),
  },
}));

const MOCK_CONFIG = {
  _projectRoot: '/project',
  _configDir: '/project/.sfdt',
  projectName: 'Test Project',
  defaultOrg: 'dev',
  sourceApiVersion: '62.0',
  defaultSourcePath: 'force-app/main/default',
  manifestDir: 'manifest/release',
  releaseNotesDir: 'release-notes',
  logDir: '/project/logs',
  features: { ai: true },
  mcp: { enabled: true },
};

const VERSION = '1.0.0';
const PORT = 7654;

describe('GUI Server Startup & MCP integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fs.existsSync.mockReturnValue(false);
    fs.pathExists.mockResolvedValue(false);
    fs.readJson.mockResolvedValue({});
    fs.readFile.mockResolvedValue('');
  });

  it('startGuiServer binds to port 0 successfully', async () => {
    const server = await startGuiServer(0, MOCK_CONFIG, VERSION);
    expect(server).toBeDefined();
    expect(server.address()).toBeDefined();
    
    const port = server.address().port;
    expect(port).toBeGreaterThan(0);

    // Call cleanup route directly
    await new Promise((resolve) => {
      server.close(resolve);
    });
  });

  it('serves fallback HTML when GUI dist/ index.html does not exist', async () => {
    fs.existsSync.mockReturnValueOnce(false); // gui/dist path check
    const app = createGuiApp(MOCK_CONFIG, VERSION, PORT);

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('SFDT Dashboard');
    expect(res.text).toContain('Build Required');
  });

  it('triggers mcpClient connection and cleanup on AI chat endpoint', async () => {
    const app = createGuiApp(MOCK_CONFIG, VERSION, PORT);

    // Send a mock request to /api/ai/chat to trigger mcpClient setup
    const res = await request(app)
      .post('/api/ai/chat')
      .send({
        messages: [{ role: 'user', content: 'test message' }],
      });

    expect(res.status).toBe(200);
    
    expect(mockGetDevOpsCenterContext).toHaveBeenCalled();

    // Call app.cleanup to verify disconnect is triggered
    await app.cleanup();
    
    expect(mockDisconnect).toHaveBeenCalled();
  });

  it('handles errors gracefully in /api/ai/available', async () => {
    const { isAiAvailable } = await import('../../src/lib/ai.js');
    vi.mocked(isAiAvailable).mockRejectedValueOnce(new Error('AI availability check failed'));

    const app = createGuiApp(MOCK_CONFIG, VERSION, PORT);
    const res = await request(app).get('/api/ai/available');
    
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(false);
    expect(res.body.enabled).toBe(false);
    expect(res.body.provider).toBeNull();
  });
});
