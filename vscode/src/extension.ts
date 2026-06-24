import * as vscode from 'vscode';
import { runSfdt } from './lib/cli.js';
import { COMMAND_CATALOG, findCommand, type CommandEntry } from './lib/commands.js';
import { OrgHealthProvider } from './tree.js';
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
function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('SFDT');
  const tree = new OrgHealthProvider(workspaceRoot);
  const dashboard = new DashboardController(cliPath, workspaceRoot, dashboardPort);
  const statusBar = new StatusBar(workspaceRoot);

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('sfdtOrgHealth', tree),
    output,
    statusBar,
    { dispose: () => dashboard.dispose() },
  );

  const refreshAll = async () => {
    await Promise.all([tree.refresh(), statusBar.refresh(defaultOrg())]);
  };

  /** Run an sfdt command with progress, stream output, then refresh views. */
  const run = async (args: string[], label: string) => {
    output.show(true);
    output.appendLine(`\n$ sfdt ${args.join(' ')}`);
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `SFDT: ${label}…`, cancellable: false },
      async () => {
        try {
          const res = await runSfdt(args, { cliPath: cliPath(), cwd: workspaceRoot(), org: defaultOrg() });
          if (res.stdout) output.append(res.stdout);
          if (res.stderr) output.append(res.stderr);
          if (res.code === 0) {
            vscode.window.showInformationMessage(`SFDT: ${label} complete`);
          } else {
            vscode.window.showWarningMessage(`SFDT: ${label} exited with code ${res.code}`);
          }
        } catch (err) {
          vscode.window.showErrorMessage(`SFDT: ${label} failed — ${(err as Error).message}`);
        }
      },
    );
    await refreshAll();
  };

  const runEntry = async (entry: CommandEntry) => {
    if (entry.destructive) {
      const ok = await vscode.window.showWarningMessage(
        `Run "sfdt ${entry.args.join(' ')}"? This can modify the org.`,
        { modal: true },
        'Run',
      );
      if (ok !== 'Run') return;
    }
    await run(entry.args, entry.label);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('sfdt.refresh', refreshAll),
    vscode.commands.registerCommand('sfdt.openDashboard', () => dashboard.open()),
    vscode.commands.registerCommand('sfdt.audit', () => runEntry(findCommand('audit')!)),
    vscode.commands.registerCommand('sfdt.monitor', () => runEntry(findCommand('monitor')!)),
    vscode.commands.registerCommand('sfdt.backup', () => runEntry(findCommand('backup')!)),
    vscode.commands.registerCommand('sfdt.preflight', () => runEntry(findCommand('preflight')!)),
    vscode.commands.registerCommand('sfdt.deploy', () => runEntry(findCommand('deploy')!)),
    vscode.commands.registerCommand('sfdt.docs', () => runEntry(findCommand('docs')!)),
    // Invoked from tree nodes with a concrete argv.
    vscode.commands.registerCommand('sfdt.runArgs', (args: string[]) => run(args, args.join(' '))),
    vscode.commands.registerCommand('sfdt.setOrg', async () => {
      const value = await vscode.window.showInputBox({
        prompt: 'Org alias for sfdt commands (--org). Leave blank to use the project default.',
        value: defaultOrg() ?? '',
      });
      if (value !== undefined) {
        await cfg().update('defaultOrg', value, vscode.ConfigurationTarget.Workspace);
        await refreshAll();
      }
    }),
    vscode.commands.registerCommand('sfdt.runCommand', async () => {
      const pick = await vscode.window.showQuickPick(
        COMMAND_CATALOG.map((c) => ({ label: c.label, detail: c.detail, entry: c })),
        { placeHolder: 'Select an sfdt command to run' },
      );
      if (pick) await runEntry(pick.entry);
    }),
  );

  void refreshAll();
}

export function deactivate(): void {
  /* subscriptions disposed by VS Code */
}
