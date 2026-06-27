import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import { parseLaunchToken, dashboardPageUrl } from './lib/dashboard-url.js';

/**
 * Manages the embedded sfdt dashboard. Spawns `sfdt ui --no-open` once (reusing
 * the existing web GUI) and shows it inside a webview panel pointed at the local
 * server. The GUI authenticates with a one-time launch token printed on the
 * `sfdt ui` stdout — we capture it and pass it in the iframe URL, otherwise the
 * dashboard would 401 on every API call.
 */
export class DashboardController {
  private server: ChildProcess | undefined;
  private panel: vscode.WebviewPanel | undefined;
  private launchToken: string | undefined;

  constructor(
    private readonly cliPath: () => string,
    private readonly cwd: () => string | undefined,
    private readonly port: () => number,
  ) {}

  /** Open the dashboard, optionally deep-linked to a GUI page (e.g. "audit"). */
  async open(page?: string): Promise<void> {
    const port = this.port();
    await this.ensureServer();
    const url = this.pageUrl(port, page);
    if (this.panel) {
      this.panel.webview.html = iframeHtml(url);
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'sfdtDashboard',
      'SFDT Dashboard',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = iframeHtml(url);
    this.panel.onDidDispose(() => (this.panel = undefined));
  }

  private pageUrl(port: number, page?: string): string {
    return dashboardPageUrl(port, page, this.launchToken);
  }

  private async ensureServer(): Promise<void> {
    if (this.server && !this.server.killed) return;
    // --no-open: we render the GUI in the webview, not an external browser.
    this.server = spawn(this.cliPath(), ['ui', '--no-open'], {
      cwd: this.cwd(),
      env: { ...process.env },
      shell: false,
      detached: false,
    });
    this.server.on('error', (err) => {
      vscode.window.showErrorMessage(`Failed to start sfdt ui: ${err.message}`);
    });
    // Capture the launch token from the "Dashboard running at …?token=…" line.
    this.server.stdout?.on('data', (d) => {
      const token = parseLaunchToken(d.toString());
      if (token) this.launchToken = token;
    });
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
        if (await attempt()) {
          // Give stdout a beat to surface the token line after health is up.
          if (!this.launchToken) await new Promise((r) => setTimeout(r, 300));
          return;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  }

  dispose(): void {
    this.server?.kill();
    this.panel?.dispose();
  }
}

function iframeHtml(url: string): string {
  const origin = url.replace(/(https?:\/\/[^/]+).*/, '$1');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline';" />
    <style>html,body,iframe{margin:0;padding:0;height:100%;width:100%;border:0;}</style>
  </head>
  <body>
    <iframe src="${url}" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>
  </body>
</html>`;
}
