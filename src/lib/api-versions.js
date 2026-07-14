/**
 * API-version audit runner for `sfdt versions` — inventories the Salesforce
 * API versions of LOCAL source metadata (Apex classes/triggers, Flows, LWC,
 * Aura, plus sfdx-project.json sourceApiVersion) and, when an org is
 * reachable, the ORG side (per-type distributions + the org's max API
 * version), then builds a comparable report.
 *
 * Scans only the `-meta.xml` sidecars (never source bodies) — apiVersion is a
 * flat text node, parsed with doc-generator's focused `tag()` helper. The
 * `api-versions` audit check (src/lib/audit-runner.js) stays org-scoped; this
 * module owns the local dimension.
 */

import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';
import { tag } from './doc-generator.js';
import { query } from './org-query.js';
import { detectOrgRelease } from './org-release.js';

// Meta-file glob → component type. `**/`-prefixed so both package-root dirs
// (force-app, whose metadata sits under main/default/...) and direct source
// paths work. Aura bundles carry apiVersion in several meta variants
// (.cmp/.app/.evt/.intf/.tokens-meta.xml); entries without an <apiVersion>
// node (e.g. .design-meta.xml) are dropped by the null filter.
const LOCAL_PATTERNS = [
  { type: 'ApexClass', pattern: '**/classes/*.cls-meta.xml', strip: /\.cls-meta\.xml$/ },
  { type: 'ApexTrigger', pattern: '**/triggers/*.trigger-meta.xml', strip: /\.trigger-meta\.xml$/ },
  { type: 'Flow', pattern: '**/flows/*.flow-meta.xml', strip: /\.flow-meta\.xml$/ },
  { type: 'LWC', pattern: '**/lwc/*/*.js-meta.xml', strip: /\.js-meta\.xml$/ },
  { type: 'Aura', pattern: '**/aura/*/*-meta.xml', strip: /\.[a-z]+-meta\.xml$/ },
];

/**
 * Scan the project's package directories for component API versions.
 * Components whose meta omits <apiVersion> land in the `unspecified` bucket —
 * they inherit sourceApiVersion at deploy time and are never counted as
 * below-floor.
 *
 * @returns {Promise<{ components: Array<{type,name,apiVersion,file}>, sourceApiVersion: string|null }>}
 */
export async function scanLocalApiVersions(config) {
  const root = config._projectRoot;
  // config.packageDirectories entries are sfdx-project.json objects
  // ({ path, absolutePath, ... }), not strings — normalize both shapes.
  const dirs = (config.packageDirectories?.length
    ? config.packageDirectories.map((d) => d?.absolutePath ?? d?.path ?? d)
    : [config.defaultSourcePath ?? 'force-app/main/default']
  ).filter((d) => typeof d === 'string');

  const components = [];
  for (const dir of dirs) {
    const base = path.isAbsolute(dir) ? dir : path.join(root, dir);
    if (!(await fs.pathExists(base))) continue;
    for (const { type, pattern, strip } of LOCAL_PATTERNS) {
      const files = await glob(pattern, { cwd: base, absolute: true });
      for (const file of files.sort()) {
        const xml = await fs.readFile(file, 'utf8').catch(() => '');
        const v = tag(xml, 'apiVersion');
        if (type === 'Aura' && v == null) continue; // non-versioned aura meta variant
        components.push({
          type,
          name: path.basename(file).replace(strip, ''),
          apiVersion: v != null ? Number.parseFloat(v) : null,
          file: path.relative(root, file),
        });
      }
    }
  }
  return { components, sourceApiVersion: config.sourceApiVersion ?? null };
}

/**
 * Fetch the org side: max API version (best-effort) and per-type ApiVersion
 * rows via the Tooling API. Each type degrades independently — a Flow query
 * failure still returns Apex results.
 *
 * @returns {Promise<{ ceiling: number|null, release: string|null, preview: boolean,
 *   byType: Record<string, Array<{name, apiVersion}>>, degraded: string[] }>}
 */
export async function fetchOrgApiVersions(orgAlias) {
  const rel = await detectOrgRelease(orgAlias).catch(() => null);
  const ceiling = rel?.apiVersion ? Number.parseInt(rel.apiVersion, 10) : null;

  const queries = {
    ApexClass: `SELECT Name, ApiVersion FROM ApexClass WHERE NamespacePrefix = null ORDER BY ApiVersion`,
    ApexTrigger: `SELECT Name, ApiVersion FROM ApexTrigger WHERE NamespacePrefix = null ORDER BY ApiVersion`,
    Flow: `SELECT Definition.DeveloperName, ApiVersion FROM Flow WHERE Status = 'Active' ORDER BY ApiVersion`,
  };
  const byType = {};
  const degraded = [];
  await Promise.all(
    Object.entries(queries).map(async ([type, soql]) => {
      try {
        const rows = await query(orgAlias, soql, { tooling: true });
        byType[type] = rows.map((r) => ({
          name: r.Name ?? r.Definition?.DeveloperName ?? '(unknown)',
          apiVersion: r.ApiVersion,
        }));
      } catch {
        degraded.push(type);
      }
    }),
  );
  return {
    ceiling: Number.isFinite(ceiling) ? ceiling : null,
    release: rel?.release ?? null,
    preview: !!rel?.preview,
    byType,
    degraded,
  };
}

/** version→count histogram from a component list, versions ascending; null → 'unspecified'. */
function histogram(items) {
  const counts = new Map();
  for (const c of items) {
    const key = c.apiVersion == null ? 'unspecified' : String(Math.trunc(c.apiVersion));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => {
      if (a === 'unspecified') return 1;
      if (b === 'unspecified') return -1;
      return Number(a) - Number(b);
    })
    .map(([version, count]) => ({ version, count }));
}

/**
 * Pure report builder. `local` from scanLocalApiVersions, `org` from
 * fetchOrgApiVersions (or null for offline mode).
 */
export function buildReport(local, org, { minApiVersion = 45, warnBehind = 0 } = {}) {
  const minApi = Number.parseInt(minApiVersion, 10);
  const behind = Number.parseInt(warnBehind, 10) || 0;
  const ceiling = org?.ceiling ?? null;
  const effectiveFloor = Math.max(
    minApi,
    behind > 0 && Number.isFinite(ceiling) ? ceiling - behind : 0,
  );

  const classify = (items) =>
    items
      .filter((c) => c.apiVersion != null && c.apiVersion < effectiveFloor)
      .map((c) => ({ ...c, reason: c.apiVersion < minApi ? 'below-floor' : 'behind-ceiling' }));

  const localByType = {};
  for (const c of local.components) (localByType[c.type] ??= []).push(c);

  const report = {
    thresholds: { minApiVersion: minApi, warnBehind: behind, effectiveFloor },
    local: {
      sourceApiVersion: local.sourceApiVersion,
      totalComponents: local.components.length,
      byType: Object.fromEntries(
        Object.entries(localByType).map(([t, items]) => [t, { count: items.length, histogram: histogram(items) }]),
      ),
      outliers: classify(local.components),
      unspecified: local.components.filter((c) => c.apiVersion == null).length,
    },
    org: null,
  };

  if (org) {
    const orgComponents = Object.entries(org.byType).flatMap(([type, items]) =>
      items.map((i) => ({ ...i, type })),
    );
    report.org = {
      ceiling,
      release: org.release,
      preview: org.preview,
      degraded: org.degraded,
      byType: Object.fromEntries(
        Object.entries(org.byType).map(([t, items]) => [t, { count: items.length, histogram: histogram(items) }]),
      ),
      outliers: classify(orgComponents),
    };
  }
  return report;
}
