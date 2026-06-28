import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from './config.js';
import { parkIfNeeded, getParkedResult } from './mcp-parking.js';
import { execa } from 'execa';
import path from 'path';
import fs from 'fs-extra';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENTRYPOINT = path.resolve(__dirname, '..', '..', 'bin', 'sfdt.js');

const TOOLS = [
  {
    name: 'sfdt_preflight',
    description: 'Run sfdt pre-deployment validation checks (git clean state, branch naming rules, Apex test runs, coverage threshold checks, etc.). Useful before validation or deployment.',
    inputSchema: {
      type: 'object',
      properties: {
        strict: { type: 'boolean', description: 'Promote warnings to errors and fail the validation run.' }
      }
    }
  },
  {
    name: 'sfdt_drift',
    description: 'Run metadata drift detection between a target Salesforce org and local source directories.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' }
      }
    }
  },
  {
    name: 'sfdt_compare',
    description: 'Compare metadata between two orgs, or between local source and an org. Returns compare results.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'Source org alias or "local".' },
        target: { type: 'string', description: 'Target org alias.' }
      },
      required: ['source', 'target']
    }
  },
  {
    name: 'sfdt_quality',
    description: 'Analyze Apex test quality, generate IsTest boilerplate stubs, or generate a fix-plan for coverage gaps.',
    inputSchema: {
      type: 'object',
      properties: {
        generateStubs: { type: 'boolean', description: 'Generate mock Apex test class boilerplate stubs.' },
        fixPlan: { type: 'boolean', description: 'Create an AI-powered plan to resolve code coverage gaps.' }
      }
    }
  },
  {
    name: 'sfdt_logs',
    description: 'Retrieve the latest structured or raw execution logs for DevOps actions.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['preflight', 'drift', 'deploy', 'rollback', 'quality'], description: 'Type of log to retrieve.' }
      },
      required: ['type']
    }
  },
  {
    name: 'sfdt_manifest_from_git',
    description: 'Generate package.xml and destructiveChanges.xml manifests using Git diff analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        base: { type: 'string', description: 'Base git reference (default: main).' },
        head: { type: 'string', description: 'Head git reference (default: HEAD).' },
        package: { type: 'string', description: 'Target subdirectory/package name or "all".' },
        name: { type: 'string', description: 'Semantic release version/label.' }
      }
    }
  },
  {
    name: 'sfdt_validate',
    description: 'Perform a deployment validation dry-run on Salesforce without committing changes.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'string', description: 'Path to package.xml manifest.' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        testLevel: { type: 'string', enum: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'] },
        testClasses: { type: 'array', items: { type: 'string' }, description: 'Specific test classes to run.' }
      },
      required: ['targetOrg']
    }
  },
  {
    name: 'sfdt_deploy',
    description: 'Perform a metadata deployment to a target Salesforce org. Supports a smart delta mode (only git-changed metadata with smart test selection). Potentially destructive.',
    inputSchema: {
      type: 'object',
      properties: {
        manifest: { type: 'string', description: 'Path to package.xml manifest (ignored when smart=true).' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        testLevel: { type: 'string', enum: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'] },
        testClasses: { type: 'array', items: { type: 'string' }, description: 'Specific test classes to run.' },
        destructiveTiming: { type: 'string', enum: ['pre', 'post', 'none', 'only'] },
        smart: { type: 'boolean', description: 'Smart delta deploy: only metadata changed between deltaBase and deltaHead, with smart test selection.' },
        deltaBase: { type: 'string', description: 'Base git ref for smart delta (default: config or "main").' },
        deltaHead: { type: 'string', description: 'Head git ref for smart delta (default: HEAD).' },
        dryRun: { type: 'boolean', description: 'Validate only (no changes applied). Recommended for smart mode in CI.' },
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute (not required when dryRun=true).' }
      },
      required: ['targetOrg']
    }
  },
  {
    name: 'sfdt_quick_deploy',
    description: 'Quick deploy a previously validated metadata validation job using validation job ID.',
    inputSchema: {
      type: 'object',
      properties: {
        validationJobId: { type: 'string', description: 'Salesforce validation job ID (0Af...).' },
        targetOrg: { type: 'string', description: 'Org alias.' },
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute.' }
      },
      required: ['validationJobId', 'targetOrg', 'confirmExecution']
    }
  },
  {
    name: 'sfdt_rollback',
    description: 'Roll back the last successful deployment using org backup snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        confirmExecution: { type: 'boolean', description: 'Must be set to true to acknowledge safety and execute.' }
      },
      required: ['confirmExecution']
    }
  },
  {
    name: 'sfdt_audit',
    description: 'Run read-only org health diagnostics (suspicious setup audit trail, license usage, MFA coverage, unused Apex classes, inactive users, deprecated API versions, inactive flows, unused permission sets, connected apps, missing field descriptions, unreferenced Apex, object access lint). Returns a normalised snapshot of check results.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        check: {
          type: 'string',
          enum: ['all', 'audittrail', 'licenses', 'mfa', 'unused-apex', 'inactive-users', 'api-versions', 'inactive-flows', 'unused-permsets', 'connected-apps', 'field-descriptions', 'apex-unreferenced', 'lint-access'],
          description: 'Run a single named check, or "all" (default).'
        }
      }
    }
  },
  {
    name: 'sfdt_monitor',
    description: 'Run org monitoring checks (org limit consumption, recent Apex job failures, security health-check score, org info, recent deployment health, legacy API usage, paused flow interviews) and optionally a full metadata backup. Returns a normalised snapshot of check results.',
    inputSchema: {
      type: 'object',
      properties: {
        org: { type: 'string', description: 'Salesforce org alias. Defaults to config defaultOrg.' },
        check: {
          type: 'string',
          enum: ['all', 'limits', 'errors', 'health', 'org-info', 'deploy-history', 'deprecated-api', 'flow-errors', 'backup'],
          description: 'Run a single named check, "backup" for a metadata backup, or "all" (default).'
        },
        backup: { type: 'boolean', description: 'When running "all", also perform a metadata backup.' }
      }
    }
  },
  {
    name: 'sfdt_docs',
    description: 'Generate MkDocs-compatible project documentation (custom objects + fields, Apex classes, Flows) with an optional AI overview and a Mermaid ER diagram of the data model.',
    inputSchema: {
      type: 'object',
      properties: {
        ai: { type: 'boolean', description: 'Enrich the index with an AI-written project overview.' }
      }
    }
  },
  {
    name: 'sfdt_get_parked_result',
    description: 'Retrieve the full payload of a previously parked tool result.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Reference string starting with parked://' }
      },
      required: ['ref']
    }
  }
];

// SEP-2549 cache metadata for tools/list: the catalog is a static module
// constant that cannot change within a process, so clients may cache it
// long-lived and share it across users.
const TOOLS_LIST_CACHE = { ttlMs: 86_400_000, cacheScope: 'global' };

// W3C Trace Context traceparent: version-traceid-parentid-flags, all lowercase hex.
const TRACEPARENT_RE = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const TRACESTATE_MAX_LENGTH = 512;

/**
 * Extracts W3C Trace Context from a request's `_meta`, validating shape so
 * attacker-controlled values can't inject into audit logs. Invalid values are
 * treated as absent.
 *
 * @param {object|undefined} meta - `request.params._meta`
 * @returns {{ traceparent: string, tracestate?: string } | null}
 */
function extractTraceContext(meta) {
  const traceparent = meta?.traceparent;
  if (typeof traceparent !== 'string' || !TRACEPARENT_RE.test(traceparent)) {
    return null;
  }
  const tracestate = meta.tracestate;
  if (
    typeof tracestate === 'string' &&
    tracestate.length > 0 &&
    tracestate.length <= TRACESTATE_MAX_LENGTH &&
    !/[\r\n]/.test(tracestate)
  ) {
    return { traceparent, tracestate };
  }
  return { traceparent };
}

export class SfdtMcpServer {
  #server;
  #config;

  async start() {
    try {
      this.#config = await loadConfig();
    } catch (err) {
      console.error(`MCP Server start failed: Config not found. ${err.message}`);
      process.exit(1);
    }

    this.#server = new Server(
      { name: 'sfdt-devops-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    this.#setupHandlers();

    const transport = new StdioServerTransport();
    await this.#server.connect(transport);
    console.error('sfdt MCP Stdio Server running...');
  }

  #setupHandlers() {
    this.#server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS,
      ttlMs: TOOLS_LIST_CACHE.ttlMs,
      cacheScope: TOOLS_LIST_CACHE.cacheScope,
    }));

    this.#server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      const trace = extractTraceContext(request.params._meta);
      const traceSuffix = trace ? ` traceparent=${trace.traceparent}` : '';

      // Log arg keys and size only — values can carry org aliases, file
      // paths, and job IDs that must not land in audit logs. Key names are
      // attacker-controlled, so neutralize characters (comma, brackets, CR/LF)
      // that could forge the bracketed list or inject extra log lines.
      const argKeys = Object.keys(args ?? {}).map((k) => k.replace(/[^\w.-]/g, '_'));
      const argBytes = Buffer.byteLength(JSON.stringify(args ?? {}), 'utf8');
      console.error(`MCP Call: ${name} argKeys=[${argKeys.join(',')}] argBytes=${argBytes}${traceSuffix}`);

      try {
        const result = await this.#executeTool(name, args ?? {});
        // Automatically check if results exceed context budgets and park them
        const processed = await parkIfNeeded(result, this.#config);

        return {
          ...(trace && { _meta: trace }),
          content: [
            {
              type: 'text',
              text: typeof processed === 'string' ? processed : JSON.stringify(processed, null, 2),
            },
          ],
        };
      } catch (err) {
        console.error(`Tool execution failed (${name})${traceSuffix}:`, err.stack || err.message);
        return {
          ...(trace && { _meta: trace }),
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error executing tool "${name}": ${err.message}`,
            },
          ],
        };
      }
    });
  }

  async #executeTool(name, args) {
    const projectRoot = this.#config._projectRoot;
    const logDir = this.#config.logDir ?? path.join(projectRoot, 'logs');

    // Handle standard tool calls
    switch (name) {
      case 'sfdt_preflight': {
        const cmdArgs = ['preflight'];
        if (args.strict) cmdArgs.push('--strict');

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_drift': {
        const cmdArgs = ['drift', '--json'];
        if (args.org) cmdArgs.push('--org', args.org);

        const { stdout } = await this.#runCliCommand(cmdArgs);
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      }

      case 'sfdt_compare': {
        const cmdArgs = ['compare', '--source', args.source, '--target', args.target];
        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);

        const latestPath = path.join(logDir, 'compare-latest.json');
        if (exitCode === 0 && await fs.pathExists(latestPath)) {
          return await fs.readJson(latestPath);
        }
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_quality': {
        const cmdArgs = ['quality'];
        if (args.generateStubs) cmdArgs.push('--generate-stubs');
        if (args.fixPlan) cmdArgs.push('--fix-plan');

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        const latestPath = path.join(logDir, 'quality-latest.json');
        if (exitCode === 0 && await fs.pathExists(latestPath)) {
          return await fs.readJson(latestPath);
        }
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_logs': {
        const type = args.type;
        if (type === 'preflight' || type === 'drift' || type === 'quality') {
          const fileMap = {
            preflight: 'preflight-latest.json',
            drift: 'drift-latest.json',
            quality: 'quality-latest.json',
          };
          const filePath = path.join(logDir, fileMap[type]);
          if (await fs.pathExists(filePath)) {
            return await fs.readJson(filePath);
          }
          return { error: `No latest log found for type: ${type}` };
        }

        const subDirMap = {
          deploy: 'deploy-results',
          rollback: 'rollback-results',
        };
        const archiveDir = path.join(logDir, subDirMap[type]);
        if (!(await fs.pathExists(archiveDir))) {
          return { error: `No log history found for type: ${type}` };
        }

        const files = (await fs.readdir(archiveDir))
          .filter((f) => f.endsWith('.json'))
          .sort();
        if (files.length === 0) {
          return { error: `No log files found in ${archiveDir}` };
        }

        const newestFile = files[files.length - 1];
        return await fs.readJson(path.join(archiveDir, newestFile));
      }

      case 'sfdt_manifest_from_git': {
        const cmdArgs = ['manifest'];
        if (args.base) cmdArgs.push('--base', args.base);
        if (args.head) cmdArgs.push('--head', args.head);
        if (args.package) cmdArgs.push('--package', args.package);
        if (args.name) cmdArgs.push('--name', args.name);

        const { exitCode, stdout, stderr } = await this.#runCliCommand(cmdArgs);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_validate': {
        // Validation = a dry-run deploy. Pass the explicit --dry-run flag so
        // deploy.js sets options.dryRun (and thus SFDT_DRY_RUN) for the script,
        // rather than relying on ambient env-var inheritance through the CLI.
        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_DRY_RUN: 'true',
        };
        if (args.manifest) env.SFDT_MANIFEST_PATH = path.resolve(projectRoot, args.manifest);
        if (args.testLevel) env.SFDT_TEST_LEVEL = args.testLevel;
        if (Array.isArray(args.testClasses) && args.testClasses.length > 0) {
          env.SFDT_SPECIFIED_TESTS = args.testClasses.join(' ');
        }

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy', '--dry-run'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_deploy': {
        // A real (non-dry-run) deploy mutates the org and requires explicit ack.
        if (!args.dryRun && !args.confirmExecution) {
          throw new Error('A real deployment is a potentially destructive action. Pass confirmExecution: true (or dryRun: true to validate only).');
        }

        if (args.smart) {
          // Smart delta deploy runs as a self-contained, non-interactive CLI path.
          const cliArgs = ['deploy', '--smart', '--agent', '--target-org', args.targetOrg];
          if (args.dryRun) cliArgs.push('--dry-run');
          if (args.deltaBase) cliArgs.push('--delta-base', args.deltaBase);
          if (args.deltaHead) cliArgs.push('--delta-head', args.deltaHead);
          const { exitCode, stdout, stderr } = await this.#runCliCommand(cliArgs, { SFDT_NON_INTERACTIVE: 'true' });
          return { exitCode, stdout, stderr };
        }

        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_DRY_RUN: args.dryRun ? 'true' : 'false',
        };
        if (args.manifest) env.SFDT_MANIFEST_PATH = path.resolve(projectRoot, args.manifest);
        if (args.testLevel) env.SFDT_TEST_LEVEL = args.testLevel;
        if (args.destructiveTiming) env.SFDT_DESTRUCTIVE_TIMING = args.destructiveTiming;
        if (Array.isArray(args.testClasses) && args.testClasses.length > 0) {
          env.SFDT_SPECIFIED_TESTS = args.testClasses.join(' ');
        }

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_quick_deploy': {
        if (!args.confirmExecution) {
          throw new Error('Quick deploy is a release-modifying action. You must pass confirmExecution: true to acknowledge authorization.');
        }

        const env = {
          SFDT_NON_INTERACTIVE: 'true',
          SFDT_TARGET_ORG: args.targetOrg,
          SFDT_VALIDATION_JOB_ID: args.validationJobId,
          SFDT_DRY_RUN: 'false',
        };

        const { exitCode, stdout, stderr } = await this.#runCliCommand(['deploy'], env);
        return { exitCode, stdout, stderr };
      }

      case 'sfdt_rollback': {
        if (!args.confirmExecution) {
          throw new Error('Rollback is a destructive state reversion. You must pass confirmExecution: true to acknowledge authorization.');
        }

        const cmdArgs = ['rollback', '--json'];
        const { stdout } = await this.#runCliCommand(cmdArgs);
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      }

      case 'sfdt_audit': {
        const check = args.check && args.check !== 'all' ? args.check : 'all';
        const cmdArgs = ['audit', check, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        const { stdout } = await this.#runCliCommand(cmdArgs);
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      }

      case 'sfdt_monitor': {
        const check = args.check && args.check !== 'all' ? args.check : 'all';
        const cmdArgs = ['monitor', check, '--json'];
        if (args.org) cmdArgs.push('--org', args.org);
        if (check === 'all' && args.backup) cmdArgs.push('--backup');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      }

      case 'sfdt_docs': {
        const cmdArgs = ['docs', 'generate', '--json'];
        if (args.ai) cmdArgs.push('--ai');
        const { stdout } = await this.#runCliCommand(cmdArgs);
        try {
          return JSON.parse(stdout);
        } catch {
          return stdout;
        }
      }

      case 'sfdt_get_parked_result': {
        return await getParkedResult(args.ref, this.#config);
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  async #runCliCommand(args, envOverrides = {}) {
    const projectRoot = this.#config._projectRoot;
    
    // Explicitly run with stdout/stderr captured (never inherit)
    // so we do not corrupt standard stdio channels of the parent MCP process.
    const result = await execa('node', [ENTRYPOINT, ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        SFDT_NON_INTERACTIVE: 'true',
        ...envOverrides,
      },
      reject: false,
    });

    return {
      exitCode: result.exitCode,
      stdout: (result.stdout ?? '').trim(),
      stderr: (result.stderr ?? '').trim(),
    };
  }
}
