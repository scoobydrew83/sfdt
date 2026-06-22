import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Manages the embedded sfdt dashboard. Spawns `sfdt ui` once (reusing the
 * existing web GUI) and shows it inside a webview panel pointed at the local
 * server, so the whole dashboard is reachable without leaving the editor.
 */
export class DashboardController {
  private server: ChildProcess | undefined;
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly cliPath: () => string,
    private readonly cwd: () => string | undefined,
    private readonly port: () => number,
  ) {}

  async open(): Promise<void> {
    const port = this.port();
    await this.ensureServer();
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'sfdtDashboard',
      'SFDT Dashboard',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const url = `http://localhost:${port}`;
    this.panel.webview.html = iframeHtml(url);
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  private async ensureServer(): Promise<void> {
    if (this.server && !this.server.killed) return;
    this.server = spawn(this.cliPath(), ['ui'], {
      cwd: this.cwd(),
      env: { ...process.env },
      shell: false,
      detached: false,
    });
    this.server.on('error', (err) => {
      vscode.window.showErrorMessage(`Failed to start sfdt ui: ${err.message}`);
    });
    // Give the server a moment to bind before the webview loads it.
    await new Promise((r) => setTimeout(r, 1200));
  }

  dispose(): void {
    this.server?.kill();
    this.panel?.dispose();
  }
}

function iframeHtml(url: string): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${url}; style-src 'unsafe-inline';" />
    <style>html,body,iframe{margin:0;padding:0;height:100%;width:100%;border:0;}</style>
  </head>
  <body>
    <iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
  </body>
</html>`;
}
