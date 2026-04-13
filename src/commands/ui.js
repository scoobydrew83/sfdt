import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';
import { startGuiServer } from '../lib/gui-server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8'),
);

const DEFAULT_PORT = 7654;

export function registerUiCommand(program) {
  program
    .command('ui')
    .description('Launch the local SFDT web dashboard (test results, drift, preflight)')
    .option('-p, --port <number>', 'Port to listen on', String(DEFAULT_PORT))
    .option('--no-open', 'Do not automatically open the browser')
    .action(async (options) => {
      const port = parseInt(options.port, 10) || DEFAULT_PORT;

      let config;
      try {
        config = await loadConfig();
      } catch {
        // Allow running ui without an sfdt project (shows empty data)
        config = { _projectRoot: process.cwd() };
      }

      print.header('SFDT Dashboard');

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

      const url = `http://localhost:${port}`;
      print.success(`Dashboard running at ${url}`);
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
      process.on('SIGINT', () => {
        print.info('\nStopping dashboard…');
        server.close(() => process.exit(0));
      });
      process.on('SIGTERM', () => {
        server.close(() => process.exit(0));
      });
    });
}
