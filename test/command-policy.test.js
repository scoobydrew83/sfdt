/**
 * COMMAND_POLICY ⇄ reality contracts. These are the drift guards the catalog
 * system rests on: a new command, MCP tool, or --json flag that isn't
 * reflected in the policy map fails CI here, before the generated catalogs
 * can go stale.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The enforcement suite at the bottom drives the real CallTool handler, so the
// SDK transport and every side-effecting dependency are stubbed. The contract
// suites above execute nothing, so these mocks are inert for them.
const mockRegisteredHandlers = new Map();

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class {
    setRequestHandler(schema, handler) { mockRegisteredHandlers.set(schema, handler); }
    async connect() {}
  },
}));
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({ StdioServerTransport: vi.fn() }));
vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  CallToolRequestSchema: 'call-tool',
  ListToolsRequestSchema: 'list-tools',
}));
vi.mock('execa', () => ({
  execa: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '{}', stderr: '' }),
}));
vi.mock('../src/lib/config.js', () => ({
  loadConfig: vi.fn().mockResolvedValue({
    _projectRoot: '/project',
    _configDir: '/project/.sfdt',
    defaultOrg: 'dev',
    logDir: '/project/logs',
  }),
}));
vi.mock('../src/lib/mcp-parking.js', () => ({
  parkIfNeeded: vi.fn().mockImplementation((v) => v),
  getParkedResult: vi.fn().mockResolvedValue({}),
}));

import { execa } from 'execa';
import { createCli } from '../src/cli.js';
import { COMMAND_POLICY, MCP_INTERNAL_TOOLS } from '../src/lib/command-policy.js';
import { TOOLS, SfdtMcpServer } from '../src/lib/mcp-server.js';
import { CHECK_IDS } from '../src/lib/audit-runner.js';

const program = createCli();
const commandNames = program.commands.map((c) => c.name());

function hasJsonOption(cmd) {
  return (
    cmd.options.some((o) => o.long === '--json') ||
    cmd.commands.some((sub) => hasJsonOption(sub))
  );
}

describe('COMMAND_POLICY coverage', () => {
  it('has exactly one entry per registered top-level command (no gaps, no orphans)', () => {
    expect(Object.keys(COMMAND_POLICY).sort()).toEqual([...commandNames].sort());
  });

  it('declares every required field on every entry', () => {
    for (const [name, p] of Object.entries(COMMAND_POLICY)) {
      for (const field of ['mutating', 'requiresProject', 'requiresOrg', 'supportsJson']) {
        expect(typeof p[field], `${name}.${field}`).toBe('boolean');
      }
      expect(typeof p.docsCategory, `${name}.docsCategory`).toBe('string');
      expect(p.surfaces, `${name}.surfaces`).toBeTruthy();
      for (const s of ['gui', 'vscode', 'chrome']) {
        expect(typeof p.surfaces[s], `${name}.surfaces.${s}`).toBe('boolean');
      }
      expect(typeof p.mcpTools, `${name}.mcpTools`).toBe('object');
    }
  });

  it('supportsJson matches the actual --json option on the command tree', () => {
    for (const cmd of program.commands) {
      expect(
        COMMAND_POLICY[cmd.name()].supportsJson,
        `${cmd.name()}: policy.supportsJson disagrees with the Commander tree`,
      ).toBe(hasJsonOption(cmd));
    }
  });
});

describe('COMMAND_POLICY ⇄ MCP tools', () => {
  const toolByName = new Map(TOOLS.map((t) => [t.name, t]));
  const claimed = Object.values(COMMAND_POLICY).flatMap((p) => Object.keys(p.mcpTools));

  it('every mcpTools entry names a real MCP tool', () => {
    for (const name of claimed) {
      expect(toolByName.has(name), `policy references unknown MCP tool ${name}`).toBe(true);
    }
  });

  it('no MCP tool is claimed by two commands', () => {
    expect(claimed.length).toBe(new Set(claimed).size);
  });

  it('every MCP tool is claimed by a command or listed as internal', () => {
    const known = new Set([...claimed, ...MCP_INTERNAL_TOOLS]);
    for (const t of TOOLS) {
      expect(known.has(t.name), `MCP tool ${t.name} is unmapped — add it to a command's mcpTools or MCP_INTERNAL_TOOLS`).toBe(true);
    }
  });

  // NOTE: this asserts the SCHEMA only. The MCP SDK types `arguments` as
  // `z.record(z.string(), z.unknown()).optional()` and never validates a tool's
  // inputSchema, so `required: ['confirmExecution']` is documentation, not a
  // control. Two tools once passed this test with no gate in the handler at all.
  // The enforcement suite at the bottom of this file is what actually guards it.
  it('mutating MCP tools DECLARE confirmExecution — and read-only ones do not carry it', () => {
    for (const p of Object.values(COMMAND_POLICY)) {
      for (const [name, meta] of Object.entries(p.mcpTools)) {
        const hasConfirm = !!toolByName.get(name)?.inputSchema?.properties?.confirmExecution;
        expect(
          hasConfirm,
          `${name}: mutating=${meta.mutating} but confirmExecution ${hasConfirm ? 'present' : 'absent'}`,
        ).toBe(meta.mutating);
      }
    }
  });

  it("the sfdt_audit check enum matches the audit runner's CHECK_IDS", () => {
    const audit = toolByName.get('sfdt_audit');
    const enumValues = audit?.inputSchema?.properties?.check?.enum;
    expect(enumValues, 'sfdt_audit must expose a check enum').toBeTruthy();
    const expected = ['all', ...CHECK_IDS].sort();
    expect([...enumValues].sort()).toEqual(expected);
  });
});

/**
 * The gate that actually bites.
 *
 * `confirmExecution` is the only thing standing between an MCP client — usually
 * an LLM, often carrying org-controlled text in its context — and a live org
 * write. The schema cannot enforce it (see the note above), so it is enforced by
 * an explicit check at the top of each handler, and enforcement is what gets
 * tested here: call every mutating tool with `confirmExecution` absent and
 * require that it refuses AND that nothing was executed.
 *
 * The `execa` assertion is the load-bearing one. An error alone proves only that
 * something went wrong; `execa` never being called proves the command never ran.
 */
describe('mutating MCP tools ENFORCE confirmExecution in the handler', () => {
  const mutatingTools = Object.values(COMMAND_POLICY)
    .flatMap((p) => Object.entries(p.mcpTools ?? {}))
    .filter(([, meta]) => meta.mutating)
    .map(([name]) => name);

  let callTool;

  beforeEach(async () => {
    mockRegisteredHandlers.clear();
    vi.clearAllMocks();
    const server = new SfdtMcpServer();
    await server.start();
    const handler = mockRegisteredHandlers.get('call-tool');
    callTool = (name, args = {}) => handler({ params: { name, arguments: args } });
  });

  // Three tools default to a READ-ONLY sub-action and gate only the mutating
  // branch, which is correct — a bare {} on these is a legitimate read. So the
  // test has to ASK for the mutating shape. Every tool not listed here must
  // refuse a bare {}.
  const MUTATING_ARGS = {
    sfdt_apex_trace: { action: 'start' },  // default action is 'list' (read-only)
    sfdt_scratch_pool: { action: 'fill' }, // default action is 'status' (read-only)
    sfdt_retrofit: { execute: true },      // without execute it is validate-only
  };

  const mutatingArgsFor = (name) => MUTATING_ARGS[name] ?? {};

  it('covers every mutating tool the policy declares', () => {
    // Guards the guard: if this ever reads 0, the suite below is vacuous.
    expect(mutatingTools.length).toBeGreaterThanOrEqual(21);
  });

  it('every conditionally-gated tool named above is still a real mutating tool', () => {
    // Stops the exemption list from outliving the tool it exempts: a renamed or
    // deleted tool would otherwise leave a stale entry that silently weakens
    // nothing today but hides the next one.
    for (const name of Object.keys(MUTATING_ARGS)) {
      expect(mutatingTools, `${name} is exempted from the bare-{} check but is not a mutating tool`).toContain(name);
    }
  });

  it.each(mutatingTools)('%s refuses without confirmExecution, and runs nothing', async (name) => {
    const result = await callTool(name, mutatingArgsFor(name));

    expect(result.isError, `${name}: expected a refusal, got a success`).toBe(true);
    expect(
      result.content[0].text,
      `${name}: refused, but not because of confirmExecution — the gate may be missing and another error fired first`,
    ).toMatch(/confirmExecution/);
    expect(
      execa,
      `${name}: REFUSED BUT STILL EXECUTED — the gate did not stop the command`,
    ).not.toHaveBeenCalled();
  });

  it.each(mutatingTools)('%s proceeds past the gate when confirmExecution is true', async (name) => {
    // The mirror image: proves each refusal above is the gate doing its job and
    // not an unrelated failure that would mask a missing gate.
    const result = await callTool(name, { ...mutatingArgsFor(name), confirmExecution: true });
    const text = result.isError ? result.content[0].text : '';
    expect(text, `${name}: still blocked on confirmExecution when it was supplied`).not.toMatch(
      /confirmExecution/,
    );
  });
});
