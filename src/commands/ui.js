import { readFileSync } from 'fs';
import os from 'os';
import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { loadConfig } from '../lib/config.js';
import { print, printSplash } from '../lib/output.js';
import { startGuiServer } from '../lib/gui-server/index.js';
import { DEFAULT_UI_PORT } from '../lib/ui-port.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
);

export function registerUiCommand(program) {
  program
    .command('ui')
    .description('Launch the local SFDT web dashboard (test results, drift, preflight)')
    .option('-p, --port <number>', 'Port to listen on', String(DEFAULT_UI_PORT))
    .option('--no-open', 'Do not automatically open the browser')
    .action(async (options) => {
      const port = parseInt(options.port, 10) || DEFAULT_UI_PORT;

      let config;
      try {
        config = await loadConfig();
      } catch {
        // Allow running ui without an sfdt project (shows empty data)
        config = { _projectRoot: process.cwd() };
      }

      printSplash({ version: pkg.version, size: 'block' });

      let server;
      try {
        server = await startGuiServer(port, config, pkg.version);
      } catch (err) {
        if (err.code === 'EADDRINUSE') {
          print.error(`Port ${port} is already in use. Try: sfdt ui --port <other>`);
        } else {
          print.error(`Failed to start server: ${err.message}`);
        }
        process.exitCode = 1;
        return;
      }

      // The dashboard authenticates with a one-time launch token generated fresh
      // on every start. The browser must load the *tokened* URL — opening the
      // bare http://localhost:<port> (a bookmark, history, or a tab left over
      // from a previous launch) sends no/stale token and 401s on /api/csrf-token.
      // So print the full tokened URL, not the bare host, to keep a working,
      // copy-pasteable link available even when auto-open misfires.
      const url = `http://localhost:${port}?token=${server.launchToken}`;
      print.success(`Dashboard running at ${url}`);
      print.info('Open the URL above — it includes a one-time auth token (regenerated each launch).');
      print.info('Press Ctrl+C to stop.');

      // Open browser unless suppressed.
      //
      // The tokened URL is deliberately NOT passed to `open()`: that spawns a
      // child process with the URL as an argv element, so the token lands in
      // the process table and in the browser's own argv for its lifetime —
      // readable by any other user on a shared or containerised host via
      // `ps -Ao args` or /proc/<pid>/cmdline. `~/.sfdt/bridge-token` defends the
      // same threat with mode 0600; this had no equivalent, and the client-side
      // scrub in gui/src/api.js clears the address bar but cannot clear argv.
      //
      // Instead a 0600 redirect stub carries the token: only its path reaches
      // argv, and the file is unlinked once the browser has had time to read it.
      // Making the token single-use was the other option and would break a plain
      // page reload, which re-exchanges it. (sfdt-private#21)
      if (options.open !== false) {
        let stub;
        try {
          const { default: open } = await import('open');
          stub = path.join(os.tmpdir(), `sfdt-launch-${crypto.randomBytes(8).toString('hex')}.html`);
          await fs.writeFile(
            stub,
            `<!doctype html><meta charset="utf-8"><title>Opening sfdt…</title>` +
              `<meta http-equiv="refresh" content="0;url=${url}">` +
              `<p>Opening <a href="${url}">the sfdt dashboard</a>…</p>`,
            { mode: 0o600 },
          );
          // pathToFileURL, not string concatenation: path.join gives
          // `C:\Users\…` on Windows, and `file://` + that is not a well-formed
          // file URL (it needs `file:///C:/Users/…`). The browser would fail to
          // resolve the stub, silently defeating the point of this change — the
          // operator falls back to pasting the tokened URL by hand.
          await open(pathToFileURL(stub).href);
        } catch {
          // `open` is optional — non-fatal if unavailable.
          print.info(`Open ${url} in your browser.`);
        } finally {
          if (stub) {
            // Long enough for any browser to have loaded and followed it; the
            // file is 0600 in the meantime, so the window is not a real exposure.
            setTimeout(() => { fs.remove(stub).catch(() => {}); }, 15_000).unref?.();
          }
        }
      }

      // Keep the process alive until Ctrl+C
      const shutdown = () => {
        server.close(async () => {
          await server.cleanup?.();
          process.exit(0);
        });
      };
      process.on('SIGINT', () => {
        print.info('\nStopping dashboard…');
        shutdown();
      });
      process.on('SIGTERM', shutdown);
    });
}
