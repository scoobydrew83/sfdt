import path from 'path';
import fs from 'fs-extra';
import { execa } from 'execa';

/**
 * Scratch org and pool management.
 *
 * Clean-room wrapper over `sf org create/delete/list scratch` plus a lightweight
 * pool tracked in `.sfdt/scratch-pool.json`. Arg-building and pool-state helpers
 * are pure for unit testing; the create/delete/list functions shell out to sf.
 */

export function poolFile(config) {
  const root = config._projectRoot ?? process.cwd();
  return path.join(root, '.sfdt', 'scratch-pool.json');
}

/** Build argv for `sf org create scratch`. */
export function buildCreateArgs({ definitionFile, alias, durationDays }) {
  const args = ['org', 'create', 'scratch', '--definition-file', definitionFile, '--json'];
  if (alias) args.push('--alias', alias);
  if (durationDays) args.push('--duration-days', String(durationDays));
  return args;
}

/** Create a scratch org from the configured definition file. */
export async function createScratch(config, { alias, durationDays } = {}) {
  const definitionFile = config.scratch?.definitionFile ?? 'config/project-scratch-def.json';
  const duration = durationDays ?? config.scratch?.durationDays ?? 7;
  const result = await execa('sf', buildCreateArgs({ definitionFile, alias, durationDays: duration }));
  const parsed = JSON.parse(result.stdout);
  const r = parsed.result ?? {};
  return {
    alias: alias ?? null,
    username: r.username ?? null,
    orgId: r.orgId ?? r.id ?? null,
    expirationDate: r.expirationDate ?? null,
  };
}

/** Delete a scratch org by alias or username. */
export async function deleteScratch(target) {
  await execa('sf', ['org', 'delete', 'scratch', '--target-org', target, '--no-prompt', '--json']);
  return { deleted: target };
}

/** List the org's scratch orgs (alias, username, expiration). */
export async function listScratch() {
  const result = await execa('sf', ['org', 'list', '--json']);
  const parsed = JSON.parse(result.stdout);
  const scratch = parsed.result?.scratchOrgs ?? [];
  return scratch.map((o) => ({
    alias: o.alias ?? null,
    username: o.username,
    orgId: o.orgId,
    expirationDate: o.expirationDate ?? null,
    status: o.status ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Pool state (pure where possible)
// ---------------------------------------------------------------------------

export async function readPool(config) {
  return fs.readJson(poolFile(config)).catch(() => ({ size: config.scratch?.poolSize ?? 0, members: [] }));
}

export async function writePool(config, pool) {
  const file = poolFile(config);
  await fs.ensureDir(path.dirname(file));
  await fs.writeJson(file, pool, { spaces: 2 });
}

/** How many orgs must be created to reach the desired pool size. */
export function poolDeficit(pool, desiredSize) {
  const have = Array.isArray(pool.members) ? pool.members.length : 0;
  return Math.max(0, desiredSize - have);
}

/**
 * Ensure the pool has `desiredSize` scratch orgs, creating any that are missing.
 * @returns {Promise<{created: number, size: number, members: Array}>}
 */
export async function ensurePool(config, { desiredSize } = {}) {
  const size = desiredSize ?? config.scratch?.poolSize ?? 0;
  const pool = await readPool(config);
  pool.size = size;
  pool.members = Array.isArray(pool.members) ? pool.members : [];
  const deficit = poolDeficit(pool, size);
  let created = 0;
  for (let i = 0; i < deficit; i++) {
    const alias = `sfdt-pool-${Date.now()}-${i}`;
    const org = await createScratch(config, { alias });
    pool.members.push({ ...org, alias, createdAt: new Date().toISOString() });
    created++;
  }
  await writePool(config, pool);
  return { created, size, members: pool.members };
}
