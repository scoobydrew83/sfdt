#!/usr/bin/env node
// Runs after `npm install -g @sfdt/cli`
// Kept intentionally minimal — no network calls, no telemetry.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version } = require(join(__dirname, '../package.json'));

const reset = '\x1b[0m';
const bold = '\x1b[1m';
const green = '\x1b[32m';
const cyan = '\x1b[36m';
const dim = '\x1b[2m';

console.log(`
${green}${bold}  sfdt v${version} installed successfully!${reset}

  ${bold}Get started:${reset}
    ${cyan}cd your-salesforce-project${reset}
    ${cyan}sfdt init${reset}
    ${cyan}sfdt deploy${reset}

  ${bold}Docs & source:${reset}  ${cyan}https://github.com/scoobydrew83/sfdt${reset}
  ${bold}Report an issue:${reset} ${cyan}https://github.com/scoobydrew83/sfdt/issues${reset}

  ${dim}AI features require: npm install -g @anthropic-ai/claude-code${reset}
`);
