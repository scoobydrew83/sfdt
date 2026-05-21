// `sfdt feature-flags` — operator surface for the extension kill-switch.
//
// The extension reads .sfdt/feature-flags.json on every bridge ping. This
// command lets you flip features off (or back on) without hand-editing
// JSON, and provides the JSON output mode that scripts and CI can rely on.
//
// File shape:
//   { "disabled": ["canvas-search", "flow-deploy"] }

import fs from 'fs-extra';
import path from 'path';
import { getConfigDir } from '../lib/config.js';
import { print } from '../lib/output.js';
import { resolveExitCode } from '../lib/exit-codes.js';

const FILE_NAME = 'feature-flags.json';

// Feature IDs in the extension manifest are kebab-case and bounded; the
// regex matches the shape every legitimate feature uses and protects the
// JSON file from being bloated by a pasted essay or polluted by control
// characters that survive a downstream readFile.
const FEATURE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function assertValidFeatureId(featureId) {
  if (typeof featureId !== 'string' || !FEATURE_ID_RE.test(featureId)) {
    throw new Error(
      `featureId must match ${FEATURE_ID_RE} (1–128 chars, alphanumerics, '_' or '-'). Got: ${featureId}`,
    );
  }
}

function flagsPath(startDir) {
  return path.join(getConfigDir(startDir), FILE_NAME);
}

async function readFlags(file) {
  if (!(await fs.pathExists(file))) return { disabled: [] };
  try {
    const raw = await fs.readJson(file);
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.disabled)) {
      return { disabled: [] };
    }
    const disabled = raw.disabled.filter((v) => typeof v === 'string' && v.length > 0);
    return { disabled };
  } catch (err) {
    throw new Error(`Could not parse ${file}: ${err.message}`);
  }
}

async function writeFlags(file, flags) {
  await fs.outputJson(file, flags, { spaces: 2 });
}

export function registerFeatureFlagsCommand(program) {
  const ff = program
    .command('feature-flags')
    .description(
      'Manage the extension kill-switch (.sfdt/feature-flags.json). Disabled features are skipped at extension boot.',
    );

  ff.command('list')
    .description('List currently disabled feature ids')
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      try {
        const file = flagsPath();
        const flags = await readFlags(file);
        if (options.json) {
          process.stdout.write(JSON.stringify({ ok: true, file, ...flags }, null, 2) + '\n');
          return;
        }
        if (flags.disabled.length === 0) {
          print.info('No features are disabled.');
          print.step(`(file: ${file}${(await fs.pathExists(file)) ? '' : ' — does not exist yet'})`);
          return;
        }
        print.header('Disabled features');
        for (const id of flags.disabled) {
          print.step(`• ${id}`);
        }
        print.step('');
        print.step(`file: ${file}`);
      } catch (err) {
        print.error(`feature-flags list failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });

  ff.command('disable <featureId>')
    .description('Add a feature id to the disabled list (creates the file if missing)')
    .option('--json', 'Emit the result as JSON')
    .action(async (featureId, options) => {
      try {
        assertValidFeatureId(featureId);
        const file = flagsPath();
        const flags = await readFlags(file);
        const before = flags.disabled.length;
        if (!flags.disabled.includes(featureId)) {
          flags.disabled.push(featureId);
          flags.disabled.sort();
          await writeFlags(file, flags);
        }
        const changed = flags.disabled.length !== before;
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, file, changed, disabled: flags.disabled }, null, 2) + '\n',
          );
          return;
        }
        if (changed) {
          print.success(`Disabled '${featureId}'. The extension will skip it on the next bridge ping.`);
        } else {
          print.info(`'${featureId}' was already disabled.`);
        }
      } catch (err) {
        print.error(`feature-flags disable failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });

  ff.command('enable <featureId>')
    .description('Remove a feature id from the disabled list')
    .option('--json', 'Emit the result as JSON')
    .action(async (featureId, options) => {
      try {
        assertValidFeatureId(featureId);
        const file = flagsPath();
        const flags = await readFlags(file);
        const before = flags.disabled.length;
        flags.disabled = flags.disabled.filter((id) => id !== featureId);
        const changed = flags.disabled.length !== before;
        if (changed) await writeFlags(file, flags);
        if (options.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, file, changed, disabled: flags.disabled }, null, 2) + '\n',
          );
          return;
        }
        if (changed) {
          print.success(`Enabled '${featureId}'. The extension will pick it up on the next bridge ping.`);
        } else {
          print.info(`'${featureId}' was not disabled.`);
        }
      } catch (err) {
        print.error(`feature-flags enable failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });

  ff.command('clear')
    .description('Re-enable everything (empties the disabled list; leaves the file in place)')
    .option('--remove', 'Delete the file entirely instead of writing { disabled: [] }')
    .option('--json', 'Emit the result as JSON')
    .action(async (options) => {
      try {
        const file = flagsPath();
        const existed = await fs.pathExists(file);
        if (options.remove) {
          if (existed) await fs.remove(file);
        } else {
          await writeFlags(file, { disabled: [] });
        }
        if (options.json) {
          process.stdout.write(
            JSON.stringify(
              { ok: true, file, removed: !!options.remove, existed, disabled: [] },
              null,
              2,
            ) + '\n',
          );
          return;
        }
        if (options.remove) {
          print.success(existed ? `Removed ${file}.` : `Nothing to remove — ${file} did not exist.`);
        } else {
          print.success('All features re-enabled.');
        }
      } catch (err) {
        print.error(`feature-flags clear failed: ${err.message}`);
        process.exitCode = resolveExitCode(err);
      }
    });
}
