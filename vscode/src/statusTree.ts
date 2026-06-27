import * as vscode from 'vscode';
import { statusIcon, type TreeNode } from './lib/snapshots.js';

/**
 * Tree data provider for the "Status" view. The node descriptors are produced by
 * a gatherer the extension supplies (org / git / versions / health), keeping
 * this layer a thin TreeNode → TreeItem mapper. Nodes whose `command` is set
 * become clickable (e.g. the org node opens the org picker).
 */
export class StatusProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly _onDidChange = new vscode.EventEmitter<TreeNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  private roots: TreeNode[] = [];

  constructor(private readonly gather: () => Promise<TreeNode[]>) {}

  async refresh(): Promise<void> {
    try {
      this.roots = await this.gather();
    } catch {
      this.roots = [];
    }
    this._onDidChange.fire();
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    const collapsible = node.children && node.children.length > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(node.label, collapsible);
    item.description = node.description;
    item.id = node.id;
    if (node.status) item.iconPath = new vscode.ThemeIcon(statusIcon(node.status));
    if (node.command) {
      // A special sentinel routes to the org picker; anything else runs as argv.
      if (node.command[0] === '__pickOrg') {
        item.command = { command: 'sfdt.pickOrg', title: 'Select Org', arguments: [] };
      } else {
        item.command = { command: 'sfdt.runArgs', title: 'Run', arguments: [node.command] };
      }
    }
    return item;
  }

  getChildren(node?: TreeNode): TreeNode[] {
    return node ? node.children ?? [] : this.roots;
  }
}
