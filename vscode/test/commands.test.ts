import { describe, it, expect } from 'vitest';
import {
  COMMAND_GROUPS,
  COMMAND_CATALOG,
  flattenCommands,
  findCommand,
  docsUrlFor,
  type CommandEntry,
} from '../src/lib/commands.js';

function allEntries(): CommandEntry[] {
  const out: CommandEntry[] = [];
  const walk = (e: CommandEntry) => {
    out.push(e);
    (e.children ?? []).forEach(walk);
  };
  COMMAND_GROUPS.forEach((g) => g.entries.forEach(walk));
  return out;
}

describe('COMMAND_GROUPS', () => {
  it('exposes the six top-level groups', () => {
    expect(COMMAND_GROUPS.map((g) => g.id)).toEqual([
      'deploy-release',
      'org-health',
      'quality',
      'documentation',
      'data-scratch',
      'project-tools',
    ]);
  });

  it('every group has a docsUrl on sfdt.dev and an icon', () => {
    for (const g of COMMAND_GROUPS) {
      expect(g.docsUrl).toMatch(/^https:\/\/sfdt\.dev\//);
      expect(g.icon).toBeTruthy();
    }
  });

  it('has unique ids across all entries and children', () => {
    const ids = allEntries().map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every runnable leaf has either args or a non-terminal action', () => {
    for (const leaf of flattenCommands()) {
      const runnable = (leaf.args && leaf.args.length > 0) || Boolean(leaf.action);
      expect(runnable, `${leaf.id} must be runnable`).toBe(true);
    }
  });

  it('surfaces the full CLI breadth (>= 30 runnable leaves)', () => {
    expect(flattenCommands().length).toBeGreaterThanOrEqual(30);
  });

  it('marks org/repo-mutating commands destructive', () => {
    for (const id of ['deploy', 'rollback', 'backup', 'data-delete', 'scratch-delete']) {
      expect(findCommand(id)?.destructive, `${id} should be destructive`).toBe(true);
    }
  });

  it('flags snapshot-backed commands so the views refresh', () => {
    expect(findCommand('audit')?.refreshes).toBe('audit');
    expect(findCommand('monitor-limits')?.refreshes).toBe('monitor');
    expect(findCommand('scan')?.refreshes).toBe('scan');
    expect(findCommand('drift')?.refreshes).toBe('drift');
  });
});

describe('findCommand', () => {
  it('finds top-level and nested entries', () => {
    expect(findCommand('deploy')?.args).toEqual(['deploy']);
    expect(findCommand('audit-mfa')?.args).toEqual(['audit', 'mfa']);
    expect(findCommand('scratch-pool-fill')?.args).toEqual(['scratch', 'pool', 'fill']);
  });
  it('returns undefined for unknown ids', () => {
    expect(findCommand('nope')).toBeUndefined();
  });
});

describe('docsUrlFor', () => {
  it('inherits the group docs url when the entry has none', () => {
    expect(docsUrlFor('audit')).toBe('https://sfdt.dev/cli/commands/org-health');
  });
  it('uses an entry-specific docs url when present', () => {
    expect(docsUrlFor('dashboard')).toBe('https://sfdt.dev/cli/dashboard');
  });
});

describe('COMMAND_CATALOG (flattened)', () => {
  it('equals flattenCommands output', () => {
    expect(COMMAND_CATALOG).toEqual(flattenCommands());
  });
});
