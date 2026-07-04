import * as vscode from 'vscode';
import { buildHealthTree, statusIcon, type TreeNode } from './lib/snapshots.js';
import { readSnapshots, readScanDrift } from './lib/io.js';

/**
 * Tree data provider for the "Org Health" view. Reads the latest audit/monitor
 * snapshots from the workspace logs dir and renders them as a status tree.
 * Refresh is triggered after any sfdt run completes.
 */
export class OrgHealthProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private roots: TreeNode[] = [];

  constructor(private readonly workspaceRoot: () => string | undefined) {}

  async refresh(): Promise<void> {
    const root = this.workspaceRoot();
    if (!root) {
      this.roots = [];
    } else {
      const [{ audit, monitor }, { scan, drift }] = await Promise.all([
        readSnapshots(root),
        readScanDrift(root),
      ]);
      this.roots = buildHealthTree(audit, monitor, scan, drift);
    }
    this._onDidChange.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children && node.children.length > 0
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.description = node.description;
    item.id = node.id;
    if (node.status) {
      item.iconPath = new vscode.ThemeIcon(statusIcon(node.status));
    }
    if (node.command) {
      item.command = {
        command: 'sfdt.runArgs',
        title: 'Run',
        arguments: [node.command],
      };
      item.tooltip = `Run: sfdt ${node.command.join(' ')}`;
    }
    // A richer per-check tooltip (title, status, summary) wins over the
    // generic "Run: …" hover when the snapshot layer provides one.
    if (node.tooltip) item.tooltip = node.tooltip;
    // Snapshot section nodes expose "Send snapshot to channels" via the
    // context/inline menu (see package.json view/item/context).
    if (node.snapshotType) item.contextValue = `sfdtHealthSnapshot.${node.snapshotType}`;
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children ?? [] : this.roots;
  }
}
