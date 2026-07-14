/**
 * Fails when any file under generated/ no longer matches what the code would
 * generate — i.e. a public surface changed without `npm run generate:catalogs`.
 * Thin wrapper so CI and package scripts have a stable entry point; the
 * comparison itself lives in generate-catalogs.mjs --check (in-memory, never
 * mutates the working tree).
 */

import { spawnSync } from 'node:child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const r = spawnSync(
  process.execPath,
  [path.join(here, 'generate-catalogs.mjs'), '--check'],
  { stdio: 'inherit' },
);
process.exit(r.status ?? 1);
