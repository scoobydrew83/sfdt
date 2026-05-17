#!/usr/bin/env node

/**
 * SFDT — Salesforce DevTools CLI
 * Entry point for the global npm binary.
 */

import { createCli } from '../src/cli.js';
import { loadPlugins } from '../src/lib/plugin-loader.js';

const program = createCli();

// Load plugins before parsing so they appear in --help and tab-completion
await loadPlugins(program);

program.parseAsync(process.argv);
