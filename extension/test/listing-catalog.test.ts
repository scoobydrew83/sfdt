// Drift guard for extension/listing.md. The CWS paste copy is a dashboard field,
// not a zip field, so it silently lags the catalog. This test reads
// generated/chrome-features.json (never a hand-count) and asserts the listing
// names every shipped feature, states the catalog count, and calls out the
// three that ship off.
//
// CWS-facing bullet titles that predate the catalog name live in
// LISTING_TITLE_ALIASES. Adding an alias is a product decision, same class as
// SHIPS_OFF_BY_DESIGN in feature-manifests.test.ts: a new catalog feature
// without a listing bullet must fail, not grow the alias map.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CATALOG_PATH = path.join(ROOT, 'generated', 'chrome-features.json');
const LISTING_PATH = path.join(ROOT, 'extension', 'listing.md');
const PKG_PATH = path.join(ROOT, 'extension', 'package.json');

type CatalogFeature = {
  id: string;
  name: string;
  enabledByDefault: boolean;
};

const LISTING_TITLE_ALIASES: Readonly<Record<string, string>> = {
  'ai-assistant': 'AI Assistant',
  'export-for-prompt': 'Export Schema for Prompt',
  'flow-deploy': 'Flow Deploy',
  'flow-health-check': 'Flow Health Check',
  'missing-descriptions': 'Missing Description Flags',
};

const SHIPS_OFF_IDS = ['record-delete', 'soql-bulk-delete', 'soql-nl-generate'] as const;

function listingTitle(feature: CatalogFeature): string {
  return LISTING_TITLE_ALIASES[feature.id] ?? feature.name;
}

function parseBullets(listing: string): string[] {
  const m = listing.match(/Features include:\n((?:- .+\n)+)/);
  if (!m) throw new Error('listing.md has no "Features include:" bullet list');
  return m[1]
    .trim()
    .split('\n')
    .map((line) => line.replace(/^- /, ''));
}

function bulletTitle(bullet: string): string {
  const cut = bullet.indexOf(' — ');
  return (cut === -1 ? bullet : bullet.slice(0, cut)).trim();
}

const catalog = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as {
  features: CatalogFeature[];
};
const features = catalog.features;
const listing = readFileSync(LISTING_PATH, 'utf8');
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as { version: string };
const bullets = parseBullets(listing);
const titles = bullets.map(bulletTitle);

describe('listing.md tracks generated/chrome-features.json', () => {
  it('does not hand-count — the catalog is the count', () => {
    expect(features.length).toBeGreaterThan(0);
    expect(listing).toMatch(
      new RegExp(`Updated for \\*\\*v${pkg.version.replace(/\./g, '\\.')}\\*\\* \\(${features.length} features`),
    );
    expect(listing).toContain(`adds ${features.length} productivity features`);
  });

  it('has one bullet per catalog feature, and every catalog name has a listing bullet', () => {
    expect(bullets.length).toBe(features.length);
    const missing = features
      .map((f) => listingTitle(f))
      .filter((title) => !titles.includes(title));
    expect(missing).toEqual([]);
  });

  it('does not list a title that is not in the catalog (or the alias map)', () => {
    const expected = new Set(features.map(listingTitle));
    const extra = titles.filter((t) => !expected.has(t));
    expect(extra).toEqual([]);
  });

  it('keeps the alias map a reviewed subset of catalog ids', () => {
    const ids = new Set(features.map((f) => f.id));
    const unknown = Object.keys(LISTING_TITLE_ALIASES).filter((id) => !ids.has(id));
    expect(unknown).toEqual([]);
    for (const [id, title] of Object.entries(LISTING_TITLE_ALIASES)) {
      const catalogName = features.find((f) => f.id === id)?.name;
      expect(title, id).not.toBe(catalogName);
    }
  });

  it('names the three features that ship off, and only those', () => {
    const off = features.filter((f) => f.enabledByDefault === false).map((f) => f.id);
    expect(off.sort()).toEqual([...SHIPS_OFF_IDS].sort());
    for (const id of SHIPS_OFF_IDS) {
      const feature = features.find((f) => f.id === id);
      if (!feature) throw new Error(`catalog is missing ${id}`);
      const title = listingTitle(feature);
      const bullet = bullets.find((b) => bulletTitle(b) === title);
      if (!bullet) throw new Error(`listing.md is missing a bullet for ${id} (${title})`);
      expect(bullet.toLowerCase()).toMatch(/ships off|opt-in/);
    }
    expect(listing).toMatch(
      new RegExp(`three (of those ${features.length} )?ship \\*\\*off by default\\*\\*`, 'i'),
    );
  });
});
