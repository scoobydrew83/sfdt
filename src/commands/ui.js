import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
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

      // Open browser unless suppressed
      if (options.open !== false) {
        try {
          const { default: open } = await import('open');
          await open(url);
        } catch {
          // `open` is optional — non-fatal if unavailable
          print.info(`Open ${url} in your browser.`);
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
