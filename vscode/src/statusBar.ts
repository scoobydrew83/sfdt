import * as vscode from 'vscode';
import { rollupStatus, type Snapshot } from './lib/snapshots.js';
import { readSnapshots } from './lib/io.js';

/**
 * Status-bar item showing the active org and the worst monitor/audit status,
 * with a click target that opens the dashboard.
 */
export class StatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly workspaceRoot: () => string | undefined) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'sfdt.openDashboard';
    this.item.show();
  }

  async refresh(org: string | undefined): Promise<void> {
    const root = this.workspaceRoot();
    let icon = '$(cloud)';
    if (root) {
      const { audit, monitor } = await readSnapshots(root);
      icon = worstIcon([audit, monitor]);
    }
    this.item.text = `${icon} SFDT${org ? ` · ${org}` : ''}`;
    this.item.tooltip = 'Open SFDT dashboard';
  }

  dispose(): void {
    this.item.dispose();
  }
}

function worstIcon(snaps: Array<Snapshot | null>): string {
  const checks = snaps.flatMap((s) => s?.checks ?? []);
  if (checks.length === 0) return '$(cloud)';
  const status = rollupStatus(checks);
  return status === 'fail' || status === 'error'
    ? '$(error)'
    : status === 'warn'
      ? '$(warning)'
      : '$(pass)';
}
