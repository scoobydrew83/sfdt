import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = vi.hoisted(() => ({
  connect: vi.fn(),
  close: vi.fn(),
  listTools: vi.fn(),
  callTool: vi.fn(),
}));

// Function expression (not arrow) so the mock is `new`-constructible;
// returning an object from a constructor yields that object.
const MockClientCtor = vi.hoisted(() => vi.fn(function MockClient() { return mockClient; }));
const MockTransportCtor = vi.hoisted(() => vi.fn());

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: MockClientCtor,
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: MockTransportCtor,
}));

import { SalesforceMcpClient, isMcpAvailable } from '../../src/lib/mcp-client.js';

const baseConfig = {
  defaultOrg: 'dev-org',
  mcp: { enabled: true, salesforce: { command: 'sf', args: ['mcp', 'start'] } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockClient.connect.mockResolvedValue(undefined);
  mockClient.close.mockResolvedValue(undefined);
  mockClient.listTools.mockResolvedValue({ tools: [] });
  mockClient.callTool.mockResolvedValue({ content: [] });
});

describe('isMcpAvailable', () => {
  it('reflects config.mcp.enabled', () => {
    expect(isMcpAvailable({ mcp: { enabled: true } })).toBe(true);
    expect(isMcpAvailable({ mcp: { enabled: false } })).toBe(false);
    expect(isMcpAvailable({})).toBe(false);
  });
});

describe('SalesforceMcpClient', () => {
  it('connects with the configured command and args', async () => {
    const client = new SalesforceMcpClient({
      ...baseConfig,
      mcp: { salesforce: { command: 'custom-sf', args: ['serve'] } },
    });
    await client.connect();
    expect(MockTransportCtor).toHaveBeenCalledWith({ command: 'custom-sf', args: ['serve'] });
    expect(client.isConnected()).toBe(true);
  });

  it('defaults to `sf mcp start` when no transport config is present', async () => {
    const client = new SalesforceMcpClient({ defaultOrg: 'dev-org' });
    await client.connect();
    expect(MockTransportCtor).toHaveBeenCalledWith({ command: 'sf', args: ['mcp', 'start'] });
  });

  it('does not reconnect when already connected', async () => {
    const client = new SalesforceMcpClient(baseConfig);
    await client.connect();
    await client.connect();
    expect(mockClient.connect).toHaveBeenCalledTimes(1);
  });

  it('disconnect closes the client and ignores close errors', async () => {
    const client = new SalesforceMcpClient(baseConfig);
    await client.connect();
    mockClient.close.mockRejectedValueOnce(new Error('boom'));
    await client.disconnect();
    expect(client.isConnected()).toBe(false);
  });

  it('calls pattern-matching tools with the default org and keys results by tool name', async () => {
    mockClient.listTools.mockResolvedValue({
      tools: [
        { name: 'devops__pipeline_status' },
        { name: 'unrelated_tool' },
      ],
    });
    mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const client = new SalesforceMcpClient(baseConfig);
    const result = await client.getPipelineStatus();

    expect(mockClient.callTool).toHaveBeenCalledTimes(1);
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'devops__pipeline_status',
      arguments: { targetOrg: 'dev-org' },
    });
    expect(result).toEqual({ devops__pipeline_status: [{ type: 'text', text: 'ok' }] });
  });

  it('returns null when no tools match the patterns', async () => {
    mockClient.listTools.mockResolvedValue({ tools: [{ name: 'unrelated' }] });
    const client = new SalesforceMcpClient(baseConfig);
    expect(await client.getPipelineStatus()).toBeNull();
  });

  it('skips tools that throw and keeps successful results', async () => {
    mockClient.listTools.mockResolvedValue({
      tools: [{ name: 'get_work_item' }, { name: 'list_work_items' }],
    });
    mockClient.callTool
      .mockRejectedValueOnce(new Error('not authorized'))
      .mockResolvedValueOnce({ content: [{ type: 'text', text: 'items' }] });

    const client = new SalesforceMcpClient(baseConfig);
    const result = await client.getWorkItems();
    expect(result).toEqual({ list_work_items: [{ type: 'text', text: 'items' }] });
  });

  describe('getDevOpsCenterContext', () => {
    it('returns combined pipeline and work item data and caches it', async () => {
      mockClient.listTools.mockResolvedValue({
        tools: [{ name: 'devops__pipeline_status' }, { name: 'get_work_item' }],
      });
      mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });

      const client = new SalesforceMcpClient(baseConfig);
      const first = await client.getDevOpsCenterContext();
      expect(first.pipeline).toBeTruthy();
      expect(first.workItems).toBeTruthy();

      const listCalls = mockClient.listTools.mock.calls.length;
      const second = await client.getDevOpsCenterContext();
      expect(second).toBe(first);
      expect(mockClient.listTools.mock.calls.length).toBe(listCalls);
    });

    it('returns null when the connection fails', async () => {
      mockClient.connect.mockRejectedValue(new Error('no sf CLI'));
      const client = new SalesforceMcpClient(baseConfig);
      expect(await client.getDevOpsCenterContext()).toBeNull();
    });
  });
});
