import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';
import { BRIDGE_REQUIRED } from '../lib/feature-defaults.js';

// The options page renders against chrome.* and the live feature registry, so
// these assert its STRUCTURE from source plus the shared CSS it depends on,
// rather than booting the page. That is enough to pin the two decisions that
// were made here — a two-column layout and a pinned commit bar — and to catch
// the classes being renamed out from under it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.resolve(HERE, '..', 'entrypoints', 'options', 'main.ts'), 'utf8');

describe('options page — layout', () => {
  it('lays out in two columns via the shared bento grid', () => {
    // Nineteen cards in one 720px stack put theme and telemetry below a
    // 44-row feature list, where nobody found them.
    expect(SRC).toContain("el('div', { class: 'sfdt-bento' })");
    expect(SRC).toMatch(/const mainCol = el\('div', \{ class: 'sfdt-bento-col' \}\)/);
    expect(SRC).toMatch(/const sideCol = el\('div', \{ class: 'sfdt-bento-col' \}\)/);
  });

  it('splits the sections by weight — long ones left, short ones right', () => {
    for (const heavy of ['bridgeSection', 'featuresSection']) {
      expect(SRC, heavy).toContain(`mainCol.appendChild(${heavy})`);
    }
    for (const light of ['appearanceSection', 'activitySection', 'telemetrySection', 'shortcutsSection']) {
      expect(SRC, light).toContain(`sideCol.appendChild(${light})`);
    }
    // Per-feature schema cards follow the feature list they belong to.
    expect(SRC).toContain('mainCol.appendChild(section)');
  });

  it('collapses to one column on a narrow window', () => {
    // A two-column form in a 500px-wide options popup is worse than one.
    expect(SFDT_COMPONENT_CSS).toMatch(
      /@media \(max-width: 900px\) \{\s*\.sfdt-bento \{ grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it('pins the save bar instead of ending the page with it', () => {
    expect(SRC).toContain("el('div', { class: 'sfdt-savebar' })");
    // Outside .wrap, so it spans the window rather than the content column.
    expect(SRC).toMatch(/root\.appendChild\(wrap\);\s*(?:\/\/[^\n]*\n\s*)*root\.appendChild\(saveBar\);/);
    expect(SFDT_COMPONENT_CSS).toMatch(/\.sfdt-savebar \{[^}]*position: sticky/);
  });

  it('uses sticky rather than fixed for the save bar', () => {
    // 'fixed' leaves it outside layout, so it overlaps the last card instead of
    // reserving space under it.
    const rule = /\.sfdt-savebar \{([^}]*)\}/.exec(SFDT_COMPONENT_CSS)?.[1] ?? '';
    expect(rule).toContain('position: sticky');
    expect(rule).not.toContain('position: fixed');
  });
});

describe('options page — feature list', () => {
  it('offers a filter over the feature rows', () => {
    // 44 rows is a list you hunt through, not one you scan.
    expect(SRC).toContain("placeholder: 'Filter features…'");
    expect(SRC).toContain('applyFeatureFilter');
    // Matches contexts too, so "record_page" finds everything that runs on one.
    expect(SRC).toMatch(/haystack:\s*`\$\{manifest\.name\} \$\{manifest\.id\} \$\{manifest\.contexts\.join\(' '\)\}`/);
  });

  it('reports both numbers while filtering', () => {
    // "12 features" alone reads as the total.
    expect(SRC).toContain('${shown} of ${featureEls.length} features');
  });

  it('badges bridge-only features from the shared set, not an invented scale', () => {
    expect(SRC).toContain('BRIDGE_REQUIRED.has(manifest.id)');
    expect(SRC).toContain("b.textContent = 'Needs CLI'");
    // The set is real and non-empty, so the badge is reachable.
    expect(BRIDGE_REQUIRED.size).toBeGreaterThan(0);
    expect(BRIDGE_REQUIRED.has('flow-deploy')).toBe(true);
    expect(BRIDGE_REQUIRED.has('soql-runner')).toBe(false);
  });

  it('keeps BRIDGE_REQUIRED in lib, where the product can import it', () => {
    // It lived in test/feature-manifests.test.ts. A test is the wrong home for
    // a fact the UI has to act on — the page could not reach it, so it would
    // have had to duplicate the list or say nothing.
    const lib = readFileSync(path.resolve(HERE, '..', 'lib', 'feature-defaults.ts'), 'utf8');
    expect(lib).toContain('export const BRIDGE_REQUIRED');
    const parity = readFileSync(path.resolve(HERE, 'feature-manifests.test.ts'), 'utf8');
    expect(parity).toContain("import { BRIDGE_REQUIRED } from '../lib/feature-defaults.js'");
    expect(parity).not.toMatch(/const BRIDGE_REQUIRED = new Set/);
  });
});
