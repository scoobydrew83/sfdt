import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CACHE_TTL_MS = 30_000;

const HEADLESS360_PIPELINE_PATTERNS = ['devops__pipeline', 'get_pipeline', 'list_pipeline', 'pipeline_status'];
const HEADLESS360_WORKITEM_PATTERNS = ['devops__workitem', 'get_work_item', 'list_work_item', 'work_item'];

export class SalesforceMcpClient {
  #client = null;
  #config;
  #cache = { data: null, ts: 0 };

  constructor(config) {
    this.#config = config;
  }

  isConnected() {
    return this.#client !== null;
  }

  async connect() {
    if (this.isConnected()) return;
    const mcpCfg = this.#config.mcp?.salesforce ?? {};
    const command = mcpCfg.command ?? 'sf';
    const args = mcpCfg.args ?? ['mcp', 'start'];

    // Stateless-safe (MCP 2026-07-28 RC): stdio transport has no session-id
    // header, load balancer, or server-instance affinity, so the stateless-core
    // changes don't apply here. The persistent #client below is reused across
    // calls, which is correct for a single stdio process. If this ever migrates
    // to Streamable HTTP, do NOT persist an Mcp-Session-Id or assume the same
    // server instance answers follow-up calls — treat every request as routable
    // to any instance.
    const transport = new StdioClientTransport({ command, args });
    const client = new Client({ name: 'sfdt', version: '1.0.0' });
    await Promise.race([
      client.connect(transport),
      new Promise((_, rej) => setTimeout(() => rej(new Error('MCP connect timeout')), 5_000)),
    ]);
    this.#client = client;
  }

  async disconnect() {
    if (!this.#client) return;
    try {
      await this.#client.close();
    } catch {
      // ignore errors on close
    }
    this.#client = null;
  }

  async #callMatchingTools(tools, patterns) {
    const matched = tools.filter((t) =>
      patterns.some((p) => t.name.toLowerCase().includes(p)),
    );
    if (matched.length === 0) return null;

    const orgAlias = this.#config.defaultOrg;
    const results = {};
    for (const tool of matched) {
      try {
        const toolArgs = orgAlias ? { targetOrg: orgAlias } : {};
        const result = await this.#client.callTool({ name: tool.name, arguments: toolArgs });
        if (result?.content) results[tool.name] = result.content;
      } catch {
        // skip tools that fail (wrong args, not authorized, etc.)
      }
    }
    return Object.keys(results).length > 0 ? results : null;
  }

  async getPipelineStatus() {
    await this.connect();
    const { tools } = await this.#client.listTools();
    return this.#callMatchingTools(tools, HEADLESS360_PIPELINE_PATTERNS);
  }

  async getWorkItems() {
    await this.connect();
    const { tools } = await this.#client.listTools();
    return this.#callMatchingTools(tools, HEADLESS360_WORKITEM_PATTERNS);
  }

  async getDevOpsCenterContext() {
    const now = Date.now();
    if (this.#cache.data && now - this.#cache.ts < CACHE_TTL_MS) {
      return this.#cache.data;
    }

    try {
      await this.connect();
      const { tools } = await this.#client.listTools();

      const [pipelineResult, workItemsResult] = await Promise.allSettled([
        this.#callMatchingTools(tools, HEADLESS360_PIPELINE_PATTERNS),
        this.#callMatchingTools(tools, HEADLESS360_WORKITEM_PATTERNS),
      ]);

      const pipeline = pipelineResult.status === 'fulfilled' ? pipelineResult.value : null;
      const workItems = workItemsResult.status === 'fulfilled' ? workItemsResult.value : null;

      const data = pipeline !== null || workItems !== null ? { pipeline, workItems } : null;
      this.#cache = { data, ts: now };
      return data;
    } catch {
      return null;
    }
  }
}

export function isMcpAvailable(config) {
  return !!config.mcp?.enabled;
}
