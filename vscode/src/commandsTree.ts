import * as vscode from 'vscode';
import { COMMAND_GROUPS, type CommandEntry, type CommandGroup } from './lib/commands.js';

/**
 * Tree data provider for the "Commands" view — the full sfdt command surface,
 * grouped into categories. Group → entries → (optional) subcommands. Leaf nodes
 * carry a `sfdt.runEntry` command so a click runs them in the integrated
 * terminal. Pure presentation; all execution lives in the extension wiring.
 */

export type CmdNode =
  | { kind: 'group'; group: CommandGroup }
  | { kind: 'entry'; entry: CommandEntry };

export class CommandsProvider implements vscode.TreeDataProvider<CmdNode> {
  private readonly _onDidChange = new vscode.EventEmitter<CmdNode | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  refresh(): void {
    this._onDidChange.fire();
  }

  getTreeItem(node: CmdNode): vscode.TreeItem {
    if (node.kind === 'group') {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Collapsed);
      item.iconPath = new vscode.ThemeIcon(node.group.icon);
      item.contextValue = 'sfdtGroup';
      return item;
    }

    const { entry } = node;
    const hasChildren = !!entry.children && entry.children.length > 0;
    const item = new vscode.TreeItem(
      entry.label,
      hasChildren ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = `cmd.${entry.id}`;
    item.description = entry.detail;
    item.tooltip = entry.args ? `Run: sfdt ${entry.args.join(' ')}` : entry.detail;
    if (entry.icon) item.iconPath = new vscode.ThemeIcon(entry.icon);

    if (!hasChildren) {
      item.command = { command: 'sfdt.runEntry', title: 'Run', arguments: [entry] };
      // contextValue drives the right-click menu (Run / Copy / Docs); a
      // destructive flag lets the menu warn before running.
      item.contextValue = entry.destructive ? 'sfdtCommandDestructive' : 'sfdtCommand';
    } else {
      item.contextValue = 'sfdtParent';
    }
    return item;
  }

  getChildren(node?: CmdNode): CmdNode[] {
    if (!node) {
      return COMMAND_GROUPS.map((group) => ({ kind: 'group', group }));
    }
    if (node.kind === 'group') {
      return node.group.entries.map((entry) => ({ kind: 'entry', entry }));
    }
    return (node.entry.children ?? []).map((entry) => ({ kind: 'entry', entry }));
  }
}
