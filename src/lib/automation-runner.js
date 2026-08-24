import os from 'os';
import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { glob } from 'glob';
import {
  AUTOMATION_TYPES,
  findAutomationType,
  buildAutomationGrid,
  automationListQuery,
  metadataFetchQuery,
  toAutomationRow,
  toggledMetadata,
  activeMetadataKey,
} from '@sfdt/flow-core';
import { query } from './org-query.js';
import { recordIntent, recordOutcome, registerReverser } from './ledger.js';

/**
 * `sfdt automation` — the on/off grid, and the writes behind it.
 *
 * The type model and the three write mechanisms live in `@sfdt/flow-core`'s
 * `automation.ts`. This file supplies the transport, the metadata-deploy path,
 * and the ledger integration.
 *
 * **Every write here records its before-state first and aborts if it cannot.**
 * See the principle #5 carve-out in `ledger.js`: a change nobody recorded is a
 * change nobody can reverse.
 */

/** `AutomationQueries` over `sf data query --use-tooling-api`. Refusals throw. */
export function queriesFor(orgAlias) {
  return {
    toolingQuery: async (soql) => ({ records: await query(orgAlias, soql, { tooling: true }) }),
  };
}

/**
 * The grid: every automation component and its state.
 *
 * @param {string} orgAlias
 * @param {object} [options]
 * @param {string} [options.type] - restrict to one type id
 */
export async function runAutomationList(orgAlias, { type } = {}) {
  const types = type ? [requireType(type)] : AUTOMATION_TYPES;
  return buildAutomationGrid(queriesFor(orgAlias), { org: orgAlias, types });
}

function requireType(id) {
  const type = findAutomationType(id);
  if (!type) {
    throw new Error(
      `Unknown automation type "${id}". Known types: ${AUTOMATION_TYPES.map((t) => t.id).join(', ')}.`,
    );
  }
  return type;
}

/** Find one component by type and name, so a write has an Id to act on. */
export async function resolveComponent(orgAlias, typeId, name) {
  const type = requireType(typeId);
  const records = await query(orgAlias, automationListQuery(type), { tooling: true });
  const rows = records.map((r) => toAutomationRow(type, r)).filter(Boolean);
  const needle = name.trim().toLowerCase();
  const matches = rows.filter((r) => r.name.toLowerCase() === needle);

  if (matches.length === 0) {
    throw new Error(`No ${type.label} named "${name}" in ${orgAlias}.`);
  }
  if (matches.length > 1) {
    // Validation rules are named per object, so the same name can exist twice.
    // Guessing would toggle the wrong one.
    throw new Error(
      `${matches.length} ${type.label}s are named "${name}" (on ${matches
        .map((m) => m.object ?? '?')
        .join(', ')}). Qualify it as <Object>.<Name>.`,
    );
  }
  return { type, row: matches[0] };
}

/**
 * Resolve a possibly-qualified name: `Account.Region_Required` or `Region_Required`.
 */
export async function resolveTarget(orgAlias, typeId, name) {
  const dot = name.indexOf('.');
  if (dot <= 0) return resolveComponent(orgAlias, typeId, name);

  const [object, bare] = [name.slice(0, dot), name.slice(dot + 1)];
  const type = requireType(typeId);
  const records = await query(orgAlias, automationListQuery(type), { tooling: true });
  const rows = records.map((r) => toAutomationRow(type, r)).filter(Boolean);
  const match = rows.find(
    (r) => r.name.toLowerCase() === bare.toLowerCase() && (r.object ?? '').toLowerCase() === object.toLowerCase(),
  );
  if (!match) throw new Error(`No ${type.label} "${bare}" on ${object} in ${orgAlias}.`);
  return { type, row: match };
}

// --------------------------------------------------------------------------
// Tooling path — read-modify-write of the whole Metadata object
// --------------------------------------------------------------------------

/**
 * Fetch a component's current `Metadata`.
 *
 * This read is not an optimisation; it is a correctness requirement. A Metadata
 * write REPLACES the object, so writing without reading first would discard a
 * validation rule's formula. It is also, conveniently, the before-state.
 */
export async function fetchMetadata(orgAlias, type, id) {
  const records = await query(orgAlias, metadataFetchQuery(type, id), { tooling: true });
  const metadata = records[0]?.Metadata;
  if (metadata == null) {
    throw new Error(
      `Could not read ${type.label} ${id}'s Metadata, so there is nothing safe to write back. ` +
        `A Metadata write replaces the whole object.`,
    );
  }
  return metadata;
}

/**
 * Write a Metadata object back through `sf data update record --use-tooling-api`.
 *
 * The same transport `flow-rollback-runner.js` has used for flow activation —
 * `--values 'Metadata={json}'`, which `sf` parses as `<field>=<json-or-string>`.
 */
async function writeMetadata(orgAlias, type, id, metadata) {
  const args = [
    'data', 'update', 'record', '--use-tooling-api',
    '--sobject', type.sobject,
    '--record-id', id,
    '--values', `Metadata=${JSON.stringify(metadata)}`,
    '--target-org', orgAlias,
    '--json',
  ];
  await execa('sf', args, { env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
}

/** The value the active-key takes for on/off, per type. */
function activeValue(type, row, enable) {
  if (type.id === 'flow') {
    if (!enable) return 0;
    // Re-activating needs a version number. The ledger's before-state carries
    // the one that was active; without it there is nothing honest to pick.
    const version = row.activeVersion ?? row.latestVersion ?? null;
    if (!version) {
      throw new Error(
        `Cannot activate "${row.name}" without knowing which version to activate. Use ` +
          `\`sfdt ledger undo\` to restore the version that was active, or activate it in Setup.`,
      );
    }
    return version;
  }
  return enable;
}

// --------------------------------------------------------------------------
// Deploy path — WorkflowRule and ApexTrigger
// --------------------------------------------------------------------------

/**
 * Stage a deploy-path toggle: retrieve the component and flip its flag in
 * memory, without writing anything back yet.
 *
 * Retrieved into a TEMP dir — never the working tree, so a toggle cannot dirty
 * the repo or collide with uncommitted work. The caller is responsible for
 * calling `cleanup()`; it keeps the directory alive between staging and deploy
 * so the component is retrieved ONCE rather than once for the preview and again
 * for the write.
 *
 * `relPath` is captured because source-format layout is load-bearing:
 * `sf project deploy start --source-dir` resolves a component from its position
 * in the tree (`triggers/Foo.trigger` beside `Foo.trigger-meta.xml`), so an undo
 * that dropped the file into a flat directory would simply not deploy.
 */
export async function stageDeployToggle(orgAlias, type, row, enable) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-automation-'));
  const cleanup = () => fs.remove(tmpDir).catch(() => {});
  try {
    const member = type.id === 'workflow-rule' ? `${row.object}.${row.name}` : row.name;
    await execa('sf', [
      'project', 'retrieve', 'start',
      '--metadata', `${type.metadataType}:${member}`,
      '--target-org', orgAlias,
      '--output-dir', tmpDir,
      '--json',
    ]);

    const files = await glob('**/*', { cwd: tmpDir, absolute: true, nodir: true });
    const target = await pickStatusFile(files, type);
    if (!target) {
      throw new Error(`Retrieve returned no file carrying a status flag for ${type.metadataType}:${member}.`);
    }

    const before = await fs.readFile(target, 'utf8');
    const after = flipStatusXml(before, type, enable, row.name);
    if (after === before) {
      throw new Error(
        `Could not find the status field in ${path.basename(target)}. Refusing to deploy an ` +
          `unchanged file rather than guess at its shape.`,
      );
    }
    return { tmpDir, target, relPath: path.relative(tmpDir, target), before, after, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** The retrieved file that actually carries the on/off flag. */
async function pickStatusFile(files, type) {
  for (const file of files) {
    if (path.basename(file) === 'package.xml') continue;
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    if (type.id === 'apex-trigger' ? /<status>/.test(text) : /<active>/.test(text)) return file;
  }
  return null;
}

/**
 * Flip the on/off flag in a retrieved component's source.
 *
 * A trigger's status lives in its `-meta.xml` sidecar, a workflow rule's in the
 * rule element itself. Returning the input UNCHANGED when no flag is found is
 * deliberate and is the signal `stageDeployToggle` acts on: it refuses to
 * deploy rather than guessing at an unfamiliar file shape, because deploying a
 * file it did not understand is how a toggle turns into a regression.
 *
 * `fullName` matters for workflow rules and is not optional in practice: a
 * `.workflow` file can carry EVERY rule on the object, each with its own
 * `<active>`. Flipping the first one would deactivate an unrelated rule and
 * deploy it — a silent production regression from a command that plainly named
 * a different rule. When the named rule cannot be located and the file holds
 * more than one flag, this returns the input unchanged so the caller refuses.
 *
 * @param {string} xml
 * @param {object} type
 * @param {boolean} enable
 * @param {string} [fullName] - the rule to flip, for multi-rule files
 */
export function flipStatusXml(xml, type, enable, fullName) {
  if (type.id === 'apex-trigger') {
    return xml.replace(
      /<status>(Active|Inactive)<\/status>/,
      `<status>${enable ? 'Active' : 'Inactive'}</status>`,
    );
  }

  const next = `<active>${enable ? 'true' : 'false'}</active>`;

  if (fullName) {
    let flippedOne = false;
    const out = xml.replace(/<rules>[\s\S]*?<\/rules>/g, (block) => {
      if (flippedOne) return block;
      if (block.match(/<fullName>([^<]*)<\/fullName>/)?.[1]?.trim() !== fullName) return block;
      const flipped = block.replace(/<active>(true|false)<\/active>/, next);
      flippedOne = flipped !== block;
      return flipped;
    });
    if (flippedOne) return out;
  }

  // No named rule, or the name matched nothing. Only safe when the file is
  // unambiguous — more than one flag and we cannot know which was meant.
  if ((xml.match(/<active>(true|false)<\/active>/g) ?? []).length > 1) return xml;
  return xml.replace(/<active>(true|false)<\/active>/, next);
}

/** Write the staged change into the temp tree and deploy it. */
export async function deployStaged(orgAlias, staged) {
  await fs.writeFile(staged.target, staged.after, 'utf8');
  await execa('sf', [
    'project', 'deploy', 'start',
    '--source-dir', staged.tmpDir,
    '--target-org', orgAlias,
    '--json',
  ]);
}

// --------------------------------------------------------------------------
// The command entry point
// --------------------------------------------------------------------------

/**
 * Turn one automation component on or off.
 *
 * Order matters and is not negotiable: read the before-state, RECORD it (and
 * abort if that fails), then write, then record the outcome.
 *
 * @param {object} config
 * @param {string} orgAlias
 * @param {string} typeId
 * @param {string} name
 * @param {boolean} enable
 * @param {object} [options]
 * @param {boolean} [options.dryRun]
 * @param {string} [options.logDir]
 */
export async function setAutomationState(config, orgAlias, typeId, name, enable, { dryRun = false, logDir } = {}) {
  const { type, row } = await resolveTarget(orgAlias, typeId, name);

  if (row.active === enable) {
    return { outcome: 'no-op', type: type.id, target: row.name, active: row.active, writeNote: type.writeNote };
  }

  const dir = logDir ?? config.logDir ?? path.join(config._projectRoot, 'logs');

  if (type.writeMode === 'metadata-deploy') {
    // Staged once and reused for both the preview and the deploy — retrieving
    // twice would be slower and could see two different states.
    const staged = await stageDeployToggle(orgAlias, type, row, enable);
    try {
      if (dryRun) {
        return {
          outcome: 'dry-run',
          type: type.id,
          target: row.name,
          before: staged.before,
          after: staged.after,
          writeNote: type.writeNote,
        };
      }
      const entry = await recordIntent(dir, {
        org: orgAlias,
        kind: `automation.${type.id}`,
        target: row.object ? `${row.object}.${row.name}` : row.name,
        summary: `${enable ? 'Activate' : 'Deactivate'} ${type.label} ${row.name} (metadata deploy)`,
        // `relPath` travels with the XML: source-format layout is what makes a
        // deploy resolve, so an undo needs to rebuild the same tree shape.
        before: { mode: 'deploy', relPath: staged.relPath, xml: staged.before, id: row.id, active: row.active },
        after: { mode: 'deploy', relPath: staged.relPath, xml: staged.after, id: row.id, active: enable },
      });
      try {
        await deployStaged(orgAlias, staged);
        await recordOutcome(dir, entry.id, { status: 'applied' });
        return {
          outcome: 'applied',
          type: type.id,
          target: row.name,
          ledgerId: entry.id,
          writeNote: type.writeNote,
        };
      } catch (err) {
        await recordOutcome(dir, entry.id, { status: 'failed', error: err.message });
        throw err;
      }
    } finally {
      await staged.cleanup();
    }
  }

  // Tooling path.
  const key = activeMetadataKey(type);
  const metadata = await fetchMetadata(orgAlias, type, row.id);
  const nextMetadata = toggledMetadata(metadata, key, activeValue(type, row, enable));

  if (dryRun) {
    return {
      outcome: 'dry-run',
      type: type.id,
      target: row.name,
      before: metadata,
      after: nextMetadata,
      writeNote: type.writeNote,
    };
  }

  const entry = await recordIntent(dir, {
    org: orgAlias,
    kind: `automation.${type.id}`,
    target: row.object ? `${row.object}.${row.name}` : row.name,
    summary: `${enable ? 'Activate' : 'Deactivate'} ${type.label} ${row.name}`,
    before: { mode: 'tooling', id: row.id, sobject: type.sobject, metadata },
    after: { mode: 'tooling', id: row.id, sobject: type.sobject, metadata: nextMetadata },
  });

  try {
    await writeMetadata(orgAlias, type, row.id, nextMetadata);
    await recordOutcome(dir, entry.id, { status: 'applied' });
    return { outcome: 'applied', type: type.id, target: row.name, ledgerId: entry.id, writeNote: type.writeNote };
  } catch (err) {
    await recordOutcome(dir, entry.id, { status: 'failed', error: err.message });
    throw err;
  }
}

// --------------------------------------------------------------------------
// Reversal
// --------------------------------------------------------------------------
//
// Registered as an import side effect so the knowledge of how to reverse an
// automation change lives beside the code that made it. `ledger-reversers.js`
// imports this module before an undo, so a standalone `sfdt ledger undo` finds
// it.

async function reverseAutomation(before, entry, ctx) {
  const org = ctx.org ?? entry.org;
  if (!org) throw new Error('Cannot undo an automation change without knowing which org it was made in.');

  if (before?.mode === 'tooling') {
    // The recorded Metadata is the WHOLE object as it was, so putting it back is
    // a single write — no re-derivation, and nothing to get subtly wrong.
    const type = findAutomationType(entry.kind.replace(/^(undo:)?automation\./, ''));
    if (!type) throw new Error(`Unknown automation type in ledger kind "${entry.kind}".`);
    await writeMetadata(org, type, before.id, before.metadata);
    return { restored: 'tooling-metadata', id: before.id };
  }

  if (before?.mode === 'deploy') {
    if (!before.relPath) {
      throw new Error(
        'This change was recorded without the source path of the component, so the deploy tree ' +
          'cannot be rebuilt. Restore it from the recorded XML by hand.',
      );
    }
    // Rebuild the ORIGINAL source-format layout, not a flat file: a deploy
    // resolves a component from its position in the tree, so a lone XML in a
    // bare directory silently deploys nothing.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-automation-undo-'));
    try {
      const file = path.join(tmpDir, before.relPath);
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file, before.xml, 'utf8');
      await execa('sf', ['project', 'deploy', 'start', '--source-dir', tmpDir, '--target-org', org, '--json']);
      return { restored: 'metadata-deploy', relPath: before.relPath };
    } finally {
      await fs.remove(tmpDir).catch(() => {});
    }
  }

  throw new Error(`Ledger entry has no recognisable before-state (mode: ${before?.mode ?? 'none'}).`);
}

for (const type of AUTOMATION_TYPES) {
  registerReverser(`automation.${type.id}`, reverseAutomation);
}
