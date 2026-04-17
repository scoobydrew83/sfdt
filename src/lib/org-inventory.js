import path from 'path';
import { execa } from 'execa';
import { glob } from 'glob';
import { getMetadataType, getMemberName } from './metadata-mapper.js';

const BATCH_SIZE = 5;

/**
 * Fetch metadata member inventory from an org or local source.
 * @param {string} source - Org alias or 'local'
 * @param {object} config - Loaded sfdt config
 * @returns {Promise<Map<string, Set<string>>>} Map of type → Set of member names
 */
export async function fetchInventory(source, config) {
  if (source === 'local') return fetchLocalInventory(config);
  return fetchOrgInventory(source, config);
}

/**
 * Fetch inventory from a Salesforce org via sf CLI.
 * Batches metadata type queries in groups of BATCH_SIZE.
 */
export async function fetchOrgInventory(orgAlias, config) {
  const types = await listMetadataTypes(orgAlias);
  const inventory = new Map();

  for (let i = 0; i < types.length; i += BATCH_SIZE) {
    const batch = types.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async (type) => {
        const members = await listMetadataMembers(orgAlias, type);
        if (members.length > 0) {
          inventory.set(type, new Set(members));
        }
      }),
    );
  }

  return inventory;
}

/**
 * Fetch inventory from local source files via glob.
 */
export async function fetchLocalInventory(config) {
  const sourcePath = config.defaultSourcePath ?? 'force-app/main/default';
  const root = config._projectRoot ?? process.cwd();
  const absSource = path.join(root, sourcePath);

  const files = await glob('**/*', {
    cwd: absSource,
    nodir: true,
    absolute: false,
  });

  const inventory = new Map();

  for (const file of files) {
    const type = getMetadataType(file);
    if (type === 'SKIP' || type === 'UNKNOWN') continue;
    const member = getMemberName(file, type);
    if (!inventory.has(type)) inventory.set(type, new Set());
    inventory.get(type).add(member);
  }

  return inventory;
}

async function listMetadataTypes(orgAlias) {
  const result = await execa('sf', [
    'org',
    'list',
    'metadata-types',
    '--json',
    '--target-org',
    orgAlias,
  ]);
  const parsed = JSON.parse(result.stdout);
  return (parsed.result?.metadataObjects ?? []).map((obj) => obj.xmlName);
}

async function listMetadataMembers(orgAlias, metadataType) {
  try {
    const result = await execa('sf', [
      'org',
      'list',
      'metadata',
      '--metadata-type',
      metadataType,
      '--json',
      '--target-org',
      orgAlias,
    ]);
    const parsed = JSON.parse(result.stdout);
    return (parsed.result ?? []).map((item) => item.fullName);
  } catch {
    // Some metadata types are not retrievable; skip silently
    return [];
  }
}
