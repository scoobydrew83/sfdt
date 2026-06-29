import * as vscode from 'vscode';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import { parseLaunchToken, dashboardPageUrl, themeQueryFromKind } from './lib/dashboard-url.js';
import { findPortOwner, isRecognizedSfdtServer, killPid, type Exec } from './lib/port.js';

/** Shell-free command runner (no string interpolation) for the port helpers. */
const exec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });

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
  private currentPage: string | undefined;
  private themeListener: vscode.Disposable | undefined;

  constructor(
    private readonly cliPath: () => string,
    private readonly cwd: () => string | undefined,
    private readonly port: () => number,
  ) {}

  /** Open the dashboard, optionally deep-linked to a GUI page (e.g. "audit"). */
  async open(page?: string): Promise<void> {
    const port = this.port();
    try {
      await this.ensureServer();
    } catch (err) {
      const choice = await vscode.window.showErrorMessage(
        (err as Error).message,
        'Open Settings',
      );
      if (choice === 'Open Settings') {
        void vscode.commands.executeCommand('workbench.action.openSettings', 'sfdt.dashboardPort');
      }
      return;
    }
    this.currentPage = page;
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
    // Reload the iframe with the new ?theme= when the editor theme changes.
    this.themeListener = vscode.window.onDidChangeActiveColorTheme(() => this.reloadForTheme());
    this.panel.onDidDispose(() => {
      this.panel = undefined;
      this.themeListener?.dispose();
      this.themeListener = undefined;
    });
  }

  private reloadForTheme(): void {
    if (!this.panel) return;
    this.panel.webview.html = iframeHtml(this.pageUrl(this.port(), this.currentPage));
  }

  private pageUrl(port: number, page?: string): string {
    const theme = themeQueryFromKind(vscode.window.activeColorTheme.kind);
    return dashboardPageUrl(port, page, this.launchToken, theme);
  }

  private async ensureServer(): Promise<void> {
    if (this.server && !this.server.killed) return;
    const port = this.port();

    if ((await this.spawnAndWait(port)) === 'ok') return;

    // Our `sfdt ui` couldn't bind. Find who holds the port and, only if it's a
    // stale sfdt/node GUI server we recognise, free it and retry once. A foreign
    // process is never killed — we surface an actionable error instead.
    const owner = await findPortOwner(port, exec, process.platform);
    if (owner && isRecognizedSfdtServer(owner.command)) {
      await killPid(owner.pid, exec, process.platform);
      // Give the OS a moment to release the socket before re-binding.
      await new Promise((r) => setTimeout(r, 400));
      if ((await this.spawnAndWait(port)) === 'ok') return;
      throw new Error(
        `The dashboard couldn't start on port ${port} even after stopping a stale sfdt server (PID ${owner.pid}). Change sfdt.dashboardPort and retry.`,
      );
    }
    if (owner) {
      throw new Error(
        `Port ${port} is in use by another process (PID ${owner.pid}: ${owner.command}). Free it or change sfdt.dashboardPort.`,
      );
    }
    throw new Error(`The sfdt dashboard couldn't start on port ${port}. Change sfdt.dashboardPort and retry.`);
  }

  /**
   * Spawn `sfdt ui --no-open` and resolve its outcome:
   *  - `'ok'`     — our child bound the port, printed its launch token, and the
   *                 server answers /api/health.
   *  - `'busy'`   — the child exited reporting the port is already in use.
   *  - `'failed'` — spawn error, a non-port exit, or a timeout.
   *
   * Success is tied to OUR child's launch token (not just /api/health) so a
   * foreign server already squatting the port can't masquerade as ours.
   */
  private spawnAndWait(port: number, timeoutMs = 15000): Promise<'ok' | 'busy' | 'failed'> {
    return new Promise((resolve) => {
      // --no-open: we render the GUI in the webview, not an external browser.
      const child = spawn(this.cliPath(), ['ui', '--no-open'], {
        cwd: this.cwd(),
        env: { ...process.env },
        shell: false,
        detached: false,
      });
      this.server = child;
      this.launchToken = undefined;
      let stderr = '';
      let settled = false;
      const settle = (r: 'ok' | 'busy' | 'failed') => {
        if (settled) return;
        settled = true;
        if (r !== 'ok' && !child.killed) child.kill();
        resolve(r);
      };

      child.on('error', () => settle('failed'));
      child.stdout?.on('data', (d) => {
        const token = parseLaunchToken(d.toString());
        if (token) this.launchToken = token;
      });
      child.stderr?.on('data', (d) => { stderr += d.toString(); });
      child.on('exit', () =>
        settle(/already in use|EADDRINUSE/i.test(stderr) ? 'busy' : 'failed'),
      );

      const deadline = Date.now() + timeoutMs;
      void (async () => {
        while (!settled && Date.now() < deadline) {
          if (this.launchToken && (await this.healthOk(port))) return settle('ok');
          await new Promise((r) => setTimeout(r, 200));
        }
        settle('failed');
      })();
    });
  }

  /** Resolve true if the GUI server answers /api/health with 200. */
  private healthOk(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
      req.setTimeout(1000, () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  dispose(): void {
    this.server?.kill();
    this.themeListener?.dispose();
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
