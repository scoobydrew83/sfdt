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

  it('surfaces the full CLI breadth (>= 80 runnable leaves)', () => {
    expect(flattenCommands().length).toBeGreaterThanOrEqual(80);
  });

  it('covers the ci init provider/type matrix', () => {
    for (const provider of ['github', 'gitlab', 'azure', 'bitbucket']) {
      for (const type of ['monitor', 'deploy', 'release', 'scratch']) {
        expect(findCommand(`ci-init-${provider}-${type}`)?.args).toEqual([
          'ci', 'init', '--provider', provider, '--type', type,
        ]);
      }
    }
  });

  it('surfaces the LWC test runner without an org flag', () => {
    const lwc = findCommand('test-lwc');
    expect(lwc?.args).toEqual(['test', '--lwc']);
    expect(lwc?.noOrg).toBe(true);
  });

  it('covers the feature-flags family', () => {
    expect(findCommand('feature-flags-list')?.args).toEqual(['feature-flags', 'list']);
    expect(findCommand('feature-flags-clear')?.args).toEqual(['feature-flags', 'clear']);
    // disable/enable need a <featureId> the user appends in the terminal.
    expect(findCommand('feature-flags-disable')?.argsIncomplete).toBe(true);
    expect(findCommand('feature-flags-enable')?.argsIncomplete).toBe(true);
  });

  it('covers config get/set as incomplete-args terminal commands', () => {
    expect(findCommand('config-get')?.args).toEqual(['config', 'get']);
    expect(findCommand('config-get')?.argsIncomplete).toBe(true);
    expect(findCommand('config-set')?.args).toEqual(['config', 'set']);
    expect(findCommand('config-set')?.argsIncomplete).toBe(true);
  });

  it('covers the generic notify, pr-description, and ai prompt entries', () => {
    expect(findCommand('notify')?.args).toEqual(['notify']);
    expect(findCommand('notify')?.argsIncomplete).toBe(true);
    expect(findCommand('pr-description')?.args).toEqual(['pr-description']);
    expect(findCommand('ai-prompt')?.args).toEqual(['ai', 'prompt']);
    expect(findCommand('ai-prompt')?.argsIncomplete).toBe(true);
  });

  it('every incomplete-args entry still carries a runnable prefix', () => {
    for (const leaf of flattenCommands()) {
      if (leaf.argsIncomplete) {
        expect(leaf.args && leaf.args.length > 0, `${leaf.id} needs an args prefix`).toBe(true);
      }
    }
  });

  it('marks commands whose CLI takes no --org flag as noOrg', () => {
    // These CLI commands reject --org with "unknown option" (exit 1), so the
    // extension must not inject the configured sfdt.defaultOrg.
    for (const id of ['doctor', 'init', 'feature-flags-list', 'feature-flags-clear']) {
      expect(findCommand(id)?.noOrg, `${id} should be noOrg`).toBe(true);
    }
    // Org-scoped commands must keep --org injection.
    for (const id of ['audit', 'monitor-limits', 'deploy', 'notify-monitor', 'ci-init-github-monitor']) {
      expect(findCommand(id)?.noOrg, `${id} should keep --org injection`).toBeUndefined();
    }
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

  it('exposes the newly-added CLI commands', () => {
    expect(findCommand('agent-test')?.args).toEqual(['agent-test', '--spec']);
    expect(findCommand('agent-test')?.argsIncomplete).toBe(true);
    expect(findCommand('monitor-schedule')?.args).toEqual(['monitor', 'schedule']);
    expect(findCommand('extension-install-host')?.argsIncomplete).toBe(true);
    expect(findCommand('extension-install-host')?.noOrg).toBe(true);
    expect(findCommand('extension-uninstall-host')?.args).toEqual(['extension', 'uninstall-host']);
    expect(findCommand('skills-pack')?.args).toEqual(['skills', 'export', '--target', 'pack']);
    expect(findCommand('skills-pack')?.noOrg).toBe(true);
    expect(findCommand('plugin-create')?.args).toEqual(['plugin', 'create']);
    expect(findCommand('plugin-create')?.argsIncomplete).toBe(true);
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
