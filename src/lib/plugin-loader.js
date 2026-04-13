/**
 * SFDT Plugin Loader
 *
 * Discovers and loads sfdt plugins from three sources (in order):
 *  1. Packages listed explicitly in config.plugins[]
 *  2. Any package named sfdt-plugin-* in the project's node_modules/
 *  3. Local JS files in .sfdt/plugins/
 *
 * Each plugin must export a register(program) function.
 *
 * Plugin example (sfdt-plugin-my-thing/index.js):
 *   export function register(program) {
 *     program.command('my-thing').action(async () => { ... });
 *   }
 */

import fs from 'fs-extra';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { loadConfig } from './config.js';
import { print } from './output.js';

/**
 * Load all plugins into the Commander program.
 * Silently skips if not inside an sfdt project (no config found).
 *
 * @param {import('commander').Command} program
 */
export async function loadPlugins(program) {
  let config;
  try {
    config = await loadConfig();
  } catch {
    // Not in an sfdt project — no plugins to load, that's fine
    return;
  }

  const projectRoot = config._projectRoot;
  const configDir = config._configDir;

  const sources = [];

  // ── 1. Explicit packages from config.plugins ──────────────────────────────
  if (Array.isArray(config.plugins) && config.plugins.length > 0) {
    for (const name of config.plugins) {
      if (typeof name === 'string' && name.trim()) {
        sources.push({ name: name.trim(), type: 'package', explicit: true });
      }
    }
  }

  // ── 2. Auto-discover sfdt-plugin-* in project node_modules ───────────────
  const nodeModulesDir = path.join(projectRoot, 'node_modules');
  if (await fs.pathExists(nodeModulesDir)) {
    let entries;
    try {
      entries = await fs.readdir(nodeModulesDir);
    } catch {
      entries = [];
    }

    const explicitNames = new Set((config.plugins ?? []).map((n) => String(n)));

    for (const entry of entries) {
      if (entry.startsWith('sfdt-plugin-') && !explicitNames.has(entry)) {
        sources.push({ name: entry, type: 'package', explicit: false });
      }
    }

    // Also scan scoped packages (@org/sfdt-plugin-*)
    for (const entry of entries) {
      if (entry.startsWith('@')) {
        const scopeDir = path.join(nodeModulesDir, entry);
        let scopedEntries;
        try {
          scopedEntries = await fs.readdir(scopeDir);
        } catch {
          continue;
        }
        for (const scoped of scopedEntries) {
          if (scoped.startsWith('sfdt-plugin-')) {
            const fullName = `${entry}/${scoped}`;
            if (!explicitNames.has(fullName)) {
              sources.push({ name: fullName, type: 'package', explicit: false });
            }
          }
        }
      }
    }
  }

  // ── 3. Local plugins in .sfdt/plugins/ ───────────────────────────────────
  const localPluginsDir = path.join(configDir, 'plugins');
  if (await fs.pathExists(localPluginsDir)) {
    let files;
    try {
      files = await fs.readdir(localPluginsDir);
    } catch {
      files = [];
    }

    for (const file of files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
      sources.push({
        name: path.join(localPluginsDir, file),
        type: 'local',
        explicit: false,
      });
    }
  }

  if (sources.length === 0) return;

  // ── Load each plugin ──────────────────────────────────────────────────────
  // Create a require function rooted at the project (for package resolution)
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));

  for (const source of sources) {
    const label = source.type === 'local' ? path.basename(source.name) : source.name;

    try {
      let mod;

      if (source.type === 'local') {
        // Local file: convert to file:// URL for dynamic import
        mod = await import(pathToFileURL(source.name).href);
      } else {
        // Package: resolve from the project's node_modules
        const resolved = projectRequire.resolve(source.name);
        mod = await import(pathToFileURL(resolved).href);
      }

      const registerFn = mod.register ?? mod.default?.register;

      if (typeof registerFn !== 'function') {
        print.warning(`Plugin "${label}" does not export a register() function — skipping.`);
        continue;
      }

      registerFn(program);

      if (!source.explicit) {
        // Only log auto-discovered plugins so users know they were picked up
        print.info(`Loaded plugin: ${label}`);
      }
    } catch (err) {
      // Plugin errors are warnings, never crashes
      print.warning(`Failed to load plugin "${label}": ${err.message}`);
    }
  }
}
