#!/usr/bin/env node

/**
 * SFDT — Salesforce DevTools CLI
 * Entry point for the global npm binary.
 */

import { createCli } from '../src/cli.js';

const program = createCli();
program.parseAsync(process.argv);
