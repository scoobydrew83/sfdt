/**
 * COMMAND_POLICY ⇄ reality contracts. These are the drift guards the catalog
 * system rests on: a new command, MCP tool, or --json flag that isn't
 * reflected in the policy map fails CI here, before the generated catalogs
 * can go stale.
 */

import { describe, it, expect } from 'vitest';
import { createCli } from '../src/cli.js';
import { COMMAND_POLICY, MCP_INTERNAL_TOOLS } from '../src/lib/command-policy.js';
import { TOOLS } from '../src/lib/mcp-server.js';
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

  it('mutating MCP tools require confirmExecution — and read-only ones do not carry it', () => {
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
