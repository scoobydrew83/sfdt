import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { COMMAND_GROUPS, flattenCommands, findCommand, docsUrlFor, type CommandEntry } from './lib/commands.js';
import { buildTerminalCommand } from './lib/terminal.js';
import { buildStatusTree } from './lib/status.js';
import { evaluatePrereqs } from './lib/prereqs.js';
import { classifyOrg, colorForOrg } from './lib/org-color.js';
import { readSnapshots } from './lib/io.js';
import { OrgHealthProvider } from './tree.js';
import { CommandsProvider } from './commandsTree.js';
import { StatusProvider } from './statusTree.js';
import { DashboardController } from './dashboard.js';
import { StatusBar } from './statusBar.js';

function cfg() {
  return vscode.workspace.getConfiguration('sfdt');
}
function cliPath(): string {
  return cfg().get<string>('cliPath') || 'sfdt';
}
function defaultOrg(): string | undefined {
  return cfg().get<string>('defaultOrg') || undefined;
}
function dashboardPort(): number {
  return cfg().get<number>('dashboardPort') || 7654;
}
function orgColorEnabled(): boolean {
  return cfg().get<boolean>('orgColor') !== false;
}
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** Capture stdout from an arbitrary command (sf, git, npm). Never throws. */
function capture(cmd: string, args: string[], cwd?: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v: string) => { if (!done) { done = true; resolve(v); } };
    try {
      const child = spawn(cmd, args, { cwd, env: { ...process.env }, shell: false });
      const timer = setTimeout(() => { child.kill(); finish(''); }, timeoutMs);
      child.stdout?.on('data', (d) => (out += d.toString()));
      child.on('error', () => { clearTimeout(timer); finish(''); });
      child.on('close', () => { clearTimeout(timer); finish(out); });
    } catch {
      finish('');
    }
  });
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SFDT');
  let latestSfdtVersion: string | undefined;

  // ── Status gatherer (org / git / versions / health) ──
  const gatherStatus = async () => {
    const root = workspaceRoot();
    const org = defaultOrg();
    const [orgJson, sfVer, sfdtVer, branch] = await Promise.all([
      capture('sf', ['org', 'display', '--json', ...(org ? ['--target-org', org] : [])], root),
      capture('sf', ['--version'], root, 5000),
      capture(cliPath(), ['--version'], root, 5000),
      capture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root, 4000),
    ]);
    let instanceUrl: string | undefined;
    let connected: boolean | undefined;
    let orgAlias = org;
    try {
      const parsed = JSON.parse(orgJson);
      const r = parsed.result ?? {};
      instanceUrl = r.instanceUrl;
      connected = r.connectedStatus ? /connected/i.test(r.connectedStatus) : undefined;
      orgAlias = org ?? r.alias ?? r.username;
    } catch { /* no org / sf unavailable */ }
    const { audit, monitor } = root ? await readSnapshots(root) : { audit: null, monitor: null };
    return buildStatusTree({
      orgAlias,
      instanceUrl,
      connected,
      gitBranch: branch.trim() || undefined,
      audit,
      monitor,
      sfdtVersion: (sfdtVer.trim().split('\n')[0] || undefined),
      sfVersion: (sfVer.trim().split('\n')[0] || undefined),
      latestSfdtVersion,
    });
  };

  // ── Providers ──
  const commands = new CommandsProvider();
  const health = new OrgHealthProvider(workspaceRoot);
  const status = new StatusProvider(gatherStatus);
  const dashboard = new DashboardController(cliPath, workspaceRoot, dashboardPort);
  const statusBar = new StatusBar(workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfdtCommands', commands),
    vscode.window.registerTreeDataProvider('sfdtOrgHealth', health),
    vscode.window.registerTreeDataProvider('sfdtStatus', status),
    output,
    statusBar,
    { dispose: () => dashboard.dispose() },
  );

  // ── Integrated terminal execution ──
  let terminal: vscode.Terminal | undefined;
  const sfdtTerminal = (): vscode.Terminal => {
    if (!terminal || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({ name: 'SFDT', cwd: workspaceRoot() });
    }
    return terminal;
  };
  context.subscriptions.push(
    vscode.window.onDidCloseTerminal((t) => { if (t === terminal) terminal = undefined; }),
  );

  const runInTerminal = (args: string[]) => {
    const term = sfdtTerminal();
    term.show(true);
    term.sendText(buildTerminalCommand(args, { cliPath: cliPath(), org: defaultOrg() }));
  };

  const runEntry = async (entry: CommandEntry) => {
    if (entry.action === 'dashboard') return dashboard.open();
    if (!entry.args) return;
    if (entry.destructive) {
      const ok = await vscode.window.showWarningMessage(
        `Run "sfdt ${entry.args.join(' ')}"? This can modify the org or your project.`,
        { modal: true },
        'Run',
      );
      if (ok !== 'Run') return;
    }
    runInTerminal(entry.args);
  };

  // ── Refresh (snapshots feed Org Health + Status + status bar) ──
  const refreshViews = async () => {
    await Promise.all([health.refresh(), status.refresh(), statusBar.refresh(defaultOrg())]);
    await applyOrgColor();
  };

  // Auto-refresh when any snapshot file changes, regardless of how it was run.
  const root = workspaceRoot();
  if (root) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(root, 'logs/*-latest.json'),
    );
    watcher.onDidCreate(() => void refreshViews());
    watcher.onDidChange(() => void refreshViews());
    context.subscriptions.push(watcher);
  }

  // ── Per-org window tint ──
  async function applyOrgColor(): Promise<void> {
    if (!orgColorEnabled()) return;
    const org = defaultOrg();
    const orgJson = await capture('sf', ['org', 'display', '--json', ...(org ? ['--target-org', org] : [])], workspaceRoot());
    let customizations: Record<string, string> | null = null;
    try {
      const r = JSON.parse(orgJson).result ?? {};
      customizations = colorForOrg(classifyOrg({
        instanceUrl: r.instanceUrl,
        isSandbox: r.isSandbox,
        isScratch: r.isScratchOrg,
        isDevEdition: typeof r.edition === 'string' && /developer/i.test(r.edition),
      }));
    } catch { /* leave untinted */ }
    try {
      await cfg().update('orgColorCustomizations', undefined, vscode.ConfigurationTarget.Workspace).then(undefined, () => {});
      const workbench = vscode.workspace.getConfiguration('workbench');
      await workbench.update('colorCustomizations', customizations ?? {}, vscode.ConfigurationTarget.Workspace);
    } catch { /* color update is best-effort */ }
  }

  // ── Prerequisite / welcome context ──
  const refreshPrereqs = async () => {
    const r = workspaceRoot();
    const hasSf = (await capture('sf', ['--version'], r, 5000)).trim().length > 0;
    const hasSfdt = (await capture(cliPath(), ['--version'], r, 5000)).trim().length > 0;
    const hasConfig = !!r && fs.existsSync(path.join(r, '.sfdt', 'config.json'));
    const state = evaluatePrereqs({ hasSf, hasSfdt, hasConfig });
    await vscode.commands.executeCommand('setContext', 'sfdt:ready', state.ready);
    await vscode.commands.executeCommand('setContext', 'sfdt:hasSfdt', hasSfdt);
  };

  // ── Refresh latest-version hint without blocking ──
  const refreshLatestVersion = () => {
    void capture('npm', ['view', '@sfdt/cli', 'version'], workspaceRoot(), 6000).then((v) => {
      const trimmed = v.trim();
      if (trimmed) { latestSfdtVersion = trimmed; void status.refresh(); }
    });
  };

  // ── Commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand('sfdt.runEntry', (arg: CommandEntry | { entry: CommandEntry }) => {
      // Leaf click passes a CommandEntry; the context menu passes the CmdNode.
      const entry = arg && 'entry' in arg ? arg.entry : (arg as CommandEntry);
      return runEntry(entry);
    }),
    vscode.commands.registerCommand('sfdt.runArgs', (args: string[]) => runInTerminal(args)),
    vscode.commands.registerCommand('sfdt.refresh', () => { refreshLatestVersion(); return refreshViews(); }),
    vscode.commands.registerCommand('sfdt.openDashboard', () => dashboard.open()),

    vscode.commands.registerCommand('sfdt.searchCommands', async () => {
      const pick = await vscode.window.showQuickPick(
        flattenCommands().map((e) => ({ label: e.label, detail: e.detail, description: e.args?.join(' '), entry: e })),
        { placeHolder: 'Run an sfdt command…', matchOnDetail: true, matchOnDescription: true },
      );
      if (pick) await runEntry(pick.entry);
    }),

    vscode.commands.registerCommand('sfdt.copyCommand', async (node?: { entry?: CommandEntry }) => {
      const entry = node?.entry;
      if (!entry?.args) return;
      await vscode.env.clipboard.writeText(buildTerminalCommand(entry.args, { cliPath: cliPath(), org: defaultOrg() }));
      vscode.window.showInformationMessage('Command copied to clipboard');
    }),

    vscode.commands.registerCommand('sfdt.openCommandDocs', async (node?: { entry?: CommandEntry }) => {
      const url = node?.entry ? docsUrlFor(node.entry.id) : 'https://sfdt.dev/cli/commands';
      if (url) await vscode.env.openExternal(vscode.Uri.parse(url));
    }),

    vscode.commands.registerCommand('sfdt.pickOrg', async () => {
      const json = await capture('sf', ['org', 'list', '--json'], workspaceRoot());
      let aliases: Array<{ label: string; description?: string }> = [];
      try {
        const r = JSON.parse(json).result ?? {};
        const orgs = [...(r.nonScratchOrgs ?? []), ...(r.scratchOrgs ?? [])];
        aliases = orgs.map((o: Record<string, unknown>) => ({
          label: String(o.alias || o.username),
          description: String(o.username ?? ''),
        }));
      } catch { /* fall through to manual input */ }
      let chosen: string | undefined;
      if (aliases.length > 0) {
        const pick = await vscode.window.showQuickPick(aliases, { placeHolder: 'Select the target org' });
        chosen = pick?.label;
      } else {
        chosen = await vscode.window.showInputBox({ prompt: 'Org alias for sfdt (--org)', value: defaultOrg() ?? '' });
      }
      if (chosen !== undefined) {
        await cfg().update('defaultOrg', chosen, vscode.ConfigurationTarget.Workspace);
        await refreshViews();
      }
    }),

    vscode.commands.registerCommand('sfdt.setOrg', () => vscode.commands.executeCommand('sfdt.pickOrg')),
    vscode.commands.registerCommand('sfdt.init', () => runInTerminal(['init'])),

    // Dedicated palette shortcuts to common commands (back-compat + discoverability).
    ...(['audit', 'monitor', 'deploy', 'preflight', 'backup', 'docs-generate'].map((id) =>
      vscode.commands.registerCommand(`sfdt.${id.replace('-generate', '')}`, () => {
        const entry = findCommand(id);
        if (entry) return runEntry(entry);
      }),
    )),
  );

  // Initial population.
  void refreshPrereqs();
  refreshLatestVersion();
  void refreshViews();

  // React to config changes (org / color toggle).
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sfdt.defaultOrg') || e.affectsConfiguration('sfdt.orgColor')) {
        void refreshViews();
      }
      if (e.affectsConfiguration('sfdt.cliPath')) void refreshPrereqs();
    }),
  );

  // Keep COMMAND_GROUPS referenced so tree-shaking never drops it (defensive).
  void COMMAND_GROUPS.length;
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
