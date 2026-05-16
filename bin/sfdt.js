#!/usr/bin/env node
import { createCli } from '../src/cli.js';
import { loadPlugins } from '../src/lib/plugin-loader.js';
const program = createCli();
await loadPlugins(program);
program.parseAsync(process.argv);
