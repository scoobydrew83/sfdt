import fs from 'fs-extra';
import path from 'path';
import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { loadConfig } from './config.js';
import { print } from './output.js';
export async function loadPlugins(program) {
  let config;
  try {
    config = await loadConfig();
  } catch {
    return;
  }
  const projectRoot = config._projectRoot;
  const configDir = config._configDir;
  const sources = [];
  if (Array.isArray(config.plugins) && config.plugins.length > 0) {
    for (const name of config.plugins) {
      if (typeof name === 'string' && name.trim()) {
        sources.push({ name: name.trim(), type: 'package', explicit: true });
      }
    }
  }
  if (config.pluginOptions?.autoDiscover === true) {
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
  }
  if (sources.length === 0) return;
  const projectRequire = createRequire(path.join(projectRoot, 'package.json'));
  for (const source of sources) {
    const label = source.type === 'local' ? path.basename(source.name) : source.name;
    try {
      let mod;
      if (source.type === 'local') {
        mod = await import(pathToFileURL(source.name).href);
      } else {
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
        print.info(`Loaded plugin: ${label}`);
      }
    } catch (err) {
      print.warning(`Failed to load plugin "${label}": ${err.message}`);
    }
  }
}
