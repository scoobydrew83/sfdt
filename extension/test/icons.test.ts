import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { icon, featureIcon, ICON_NAMES, ICON_FOR_FEATURE } from '../lib/icons.js';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../lib/feature-icons.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');

describe('lib/icons', () => {
  it('builds a themable SVG in the SVG namespace', () => {
    const svg = icon('database');
    expect(svg.namespaceURI).toBe(SVG_NS);
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    // currentColor is what makes the icon free to theme — a hard-coded stroke
    // would go invisible in one of the two palettes.
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('fill')).toBe('none');
    // Decorative by default: an icon-only control labels the button, not the glyph.
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.childNodes.length).toBeGreaterThan(0);
  });

  it('honours the requested size while keeping the 24-unit viewBox', () => {
    const svg = icon('grid', 32);
    expect(svg.getAttribute('width')).toBe('32');
    expect(svg.getAttribute('height')).toBe('32');
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
  });

  it('falls back to a neutral glyph for an unknown name rather than rendering nothing', () => {
    const svg = icon('definitely-not-an-icon');
    expect(svg.childNodes.length).toBe(1);
    expect((svg.firstChild as Element).tagName).toBe('circle');
  });

  it('every icon shape is built from a known SVG primitive', () => {
    // A typo'd tag name yields an element the renderer silently drops, so the
    // icon would just be blank — cheap to assert, impossible to eyeball.
    const allowed = new Set(['line', 'circle', 'rect', 'polyline', 'polygon', 'path', 'ellipse']);
    for (const name of ICON_NAMES) {
      const svg = icon(name);
      expect(svg.childNodes.length, `${name} has no shapes`).toBeGreaterThan(0);
      for (const child of Array.from(svg.children)) {
        expect(allowed.has(child.tagName), `${name} uses <${child.tagName}>`).toBe(true);
        expect(child.namespaceURI).toBe(SVG_NS);
      }
    }
  });

  it('every path/polyline/polygon carries geometry', () => {
    // An empty `d`/`points` renders nothing — same blank-icon failure as above.
    for (const name of ICON_NAMES) {
      for (const child of Array.from(icon(name).children)) {
        if (child.tagName === 'path') {
          expect(child.getAttribute('d'), `${name} <path> has no d`).toBeTruthy();
        }
        if (child.tagName === 'polyline' || child.tagName === 'polygon') {
          expect(child.getAttribute('points'), `${name} <${child.tagName}> has no points`).toBeTruthy();
        }
      }
    }
  });

  // Parity guard: the emoji map and the line-icon map must cover the same
  // features, or a surface migrated to line icons silently renders a fallback
  // dot for whatever the newest feature is.
  describe('parity with lib/feature-icons', () => {
    it('every FEATURE_ICONS id has a line icon', () => {
      const missing = Object.keys(FEATURE_ICONS).filter((id) => !ICON_FOR_FEATURE[id]);
      expect(missing).toEqual([]);
    });

    it('every ICON_FOR_FEATURE id is a real feature', () => {
      const orphaned = Object.keys(ICON_FOR_FEATURE).filter((id) => !FEATURE_ICONS[id]);
      expect(orphaned).toEqual([]);
    });

    it('every mapped icon name exists in the set', () => {
      const dangling = Object.entries(ICON_FOR_FEATURE)
        .filter(([, name]) => !ICON_NAMES.includes(name))
        .map(([id, name]) => `${id} → ${name}`);
      expect(dangling).toEqual([]);
    });

    it('no injected-UI surface renders an emoji glyph', () => {
      // The line-icon set replaced emoji across the surfaces that mount into a
      // Salesforce page. A stray emoji is the tell that a surface was added
      // without going through lib/icons — cheap to catch, easy to miss by eye.
      // Grows as surfaces migrate onto lib/ui-controls.ts — a file joins this
      // list in the same commit that converts its buttons, which is what stops
      // the emoji creeping back in behind the new glyphs.
      const files = [
        'entrypoints/app/main.ts',
        'entrypoints/options/main.ts',
        'entrypoints/popup/main.ts',
        'entrypoints/sidepanel/main.ts',
        'features/ai-assistant.ts',
        'features/apex-anonymous.ts',
        'features/apex-test-runner.ts',
        'features/api-name-generator.ts',
        'features/api-version-audit.ts',
        'features/bridge-tools.ts',
        'features/canvas-search.ts',
        'features/code-coverage.ts',
        'features/comparison-exporter.ts',
        'features/data-import.ts',
        'features/debug-log-viewer.ts',
        'features/dependency-explorer.ts',
        'features/event-monitor.ts',
        'features/field-creator.ts',
        'features/field-impact.ts',
        'features/flow-deploy.ts',
        'features/flow-list-search.ts',
        'features/flow-quality.ts',
        'features/flow-trigger-explorer-enhancer.ts',
        'features/flow-version-manager.ts',
        'features/inspect-record.ts',
        'features/metadata-retrieve.ts',
        'features/missing-description-flags.ts',
        'features/org-health-checks.ts',
        'features/org-health.ts',
        'features/org-limits.ts',
        'features/org-release-badge.ts',
        'features/org-switcher.ts',
        'features/rest-explore.ts',
        'features/saved-soql.ts',
        'features/scheduled-flow-explorer.ts',
        'features/schema-browser.ts',
        'features/setup-tabs.ts',
        'features/show-api-names.ts',
        'features/soap-explore.ts',
        'features/soql-runner.ts',
        'features/subflow-graph.ts',
        'features/trace-flags.ts',
        'features/trigger-conflicts.ts',
        'lib/code-editor.ts',
        'lib/download.ts',
        'lib/trace-flag.ts',
        'lib/history.ts',
        'lib/palette-sources.ts',
        'lib/popup.ts',
        'lib/ui-controls.ts',
        'lib/xml.ts',
        'lib/zod-to-dom.ts',
        'ui/apex-limit-tiles.ts',
        'ui/apex-log-analyzer.ts',
        'ui/apex-log-console.ts',
        'ui/apex-log-flame-chart.ts',
        'ui/command-palette.ts',
        'ui/confirm-dialog.ts',
        'ui/health-modal.ts',
        'ui/menu.ts',
        'ui/clipboard.ts',
        'ui/meter-card.ts',
        'ui/node-graph.ts',
        'ui/panels.ts',
        'ui/present-view.ts',
        'ui/shadow-host.ts',
        'ui/side-button.ts',
        'ui/toast.ts',
        'ui/workspace-host.ts',
        'ui/workspace-tabs.ts',
      ];
      // Pictographic ranges only: the box-drawing/×/…/— characters used as
      // punctuation elsewhere are not emoji and are fine.
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
      const offenders: string[] = [];
      for (const file of files) {
        // Comments are stripped first (golden principle #12: a check must not
        // flag its own documentation — several of these files legitimately
        // mention ⚡ in prose while rendering an SVG). Trade-off: an emoji in a
        // string literal that also contains `//` would be missed.
        const source = fs
          .readFileSync(path.join(ROOT, file), 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '');
        source.split('\n').forEach((line, i) => {
          const code = line.replace(/\/\/.*$/, '');
          if (emoji.test(code)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        });
      }
      expect(offenders).toEqual([]);
    });

    it('the emoji guard actually matches an emoji (not a vacuous pass)', () => {
      // A guard whose regex silently matched nothing would stay green forever.
      const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;
      expect(emoji.test("icon.textContent = '🗂';")).toBe(true);
      expect(emoji.test("icon.textContent = '⚡';")).toBe(true);
      // …and does not fire on the punctuation these files legitimately use.
      expect(emoji.test("close.textContent = '×';")).toBe(false);
      expect(emoji.test("hint.textContent = '—';")).toBe(false);
      expect(emoji.test("more.textContent = '…';")).toBe(false);
    });

    it('every workspace tool resolves to a real glyph, not the fallback', () => {
      for (const id of WORKSPACE_TOOLS) {
        const svg = featureIcon(id);
        expect(svg.getAttribute('data-sfdt-icon'), `${id} fell back`).toBeTruthy();
        expect(ICON_NAMES).toContain(svg.getAttribute('data-sfdt-icon'));
      }
    });
  });
});
