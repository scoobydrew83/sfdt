import { SfdtMcpServer } from '../lib/mcp-server.js';
import { cleanupParkedResults } from '../lib/mcp-parking.js';
import { loadConfig } from '../lib/config.js';
import { print } from '../lib/output.js';

export function registerMcpCommand(program) {
  const mcp = program
    .command('mcp')
    .description('Manage the Model Context Protocol (MCP) server');

  mcp
    .command('start')
    .description('Start the sfdt MCP server in stdio mode')
    .action(async () => {
      const server = new SfdtMcpServer();
      await server.start();
    });

  mcp
    .command('cleanup')
    .description('Purge expired parked results from the cache directory')
    .action(async () => {
      try {
        const config = await loadConfig();
        const count = await cleanupParkedResults(config);
        print.success(`Cleaned up ${count} expired parked result file(s).`);
      } catch (err) {
        print.error(`Cleanup failed: ${err.message}`);
        process.exitCode = 1;
      }
    });
}
