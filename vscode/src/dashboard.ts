import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

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
    // Poll the health endpoint until the server is actually listening rather
    // than racing a fixed delay (which fails on slow machines or busy ports).
    await this.waitForServer(this.port());
  }

  /** Resolve once the GUI server answers /api/health, or after a timeout. */
  private waitForServer(port: number, timeoutMs = 15000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const url = `http://localhost:${port}/api/health`;
    const attempt = (): Promise<boolean> =>
      new Promise((resolve) => {
        const req = http.get(url, (res) => {
          res.resume();
          resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(1000, () => {
          req.destroy();
          resolve(false);
        });
      });
    return (async () => {
      while (Date.now() < deadline) {
        if (await attempt()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      // Fall through after the timeout — let the webview load and surface its
      // own connection error if the server never came up.
    })();
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
