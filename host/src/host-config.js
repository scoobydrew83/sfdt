/**
 * Native-host config file. Chrome launches the host outside any project, so it
 * cannot discover a Salesforce project from its cwd the way the CLI/MCP server
 * do. Instead, `sfdt extension install-host` records the target project root
 * here, and the host reads it to locate `logs/` and `.sfdt/config.json` for the
 * read-only kinds (drift/scan/compare/org-health). Honors XDG_CONFIG_HOME.
 */

import path from 'path';
import os from 'os';
import fs from 'fs-extra';

/** Absolute path to the host config file (`~/.config/sfdt-host.json`). */
export function hostConfigPath() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'sfdt-host.json');
}

/** Read the host config, or null if it is absent or unreadable. */
export async function readHostConfig() {
  try {
    const file = hostConfigPath();
    if (!(await fs.pathExists(file))) return null;
    return await fs.readJson(file);
  } catch {
    return null;
  }
}

/** Merge `patch` into the host config and persist it. Returns the written file + config. */
export async function writeHostConfig(patch) {
  const file = hostConfigPath();
  const current = (await readHostConfig()) ?? {};
  const config = { ...current, ...patch };
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, config, { spaces: 2 });
  return { file, config };
}
