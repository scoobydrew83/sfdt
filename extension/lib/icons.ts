// Line-icon set — 24×24, 1.5px stroke, `currentColor`.
//
// Why hand-authored SVG primitives rather than an icon font or an npm pack:
//   - Material Symbols / Font Awesome are WEBFONTS. An MV3 extension cannot pull
//     one from a CDN (CSP blocks it, and it would be a third-party request from
//     a tool that markets local-only telemetry). Bundling a subset is possible
//     but adds a binary to ship, version and licence-audit.
//   - Inline SVG has none of that: no network, no FOUT, works inside a shadow
//     root, inherits `currentColor` so it themes for free, and only the icons
//     actually referenced exist.
//   - Built from primitives (line/circle/rect/polyline/polygon/path/ellipse) so
//     every shape is valid by construction and the stroke weight is uniform
//     across the set. That uniformity is the point — a mixed-weight or
//     mixed-metaphor icon set is what makes a UI read as hand-made.
//
// These replace the emoji in lib/feature-icons.ts for surfaces that have been
// migrated. FEATURE_ICONS keeps its emoji for surfaces that haven't — the two
// are parallel, and ICON_FOR_FEATURE is parity-tested against it so a new
// feature can't land with an emoji and no line icon.
//
// Built with createElementNS, never innerHTML (extension rule #1).

type Shape = [tag: string, attrs: Record<string, string>];

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICONS: Record<string, Shape[]> = {
  // — navigation / chrome —
  grid: [
    ['rect', { x: '3', y: '3', width: '7', height: '7', rx: '1.5' }],
    ['rect', { x: '14', y: '3', width: '7', height: '7', rx: '1.5' }],
    ['rect', { x: '3', y: '14', width: '7', height: '7', rx: '1.5' }],
    ['rect', { x: '14', y: '14', width: '7', height: '7', rx: '1.5' }],
  ],
  search: [
    ['circle', { cx: '11', cy: '11', r: '7' }],
    ['line', { x1: '16.5', y1: '16.5', x2: '21', y2: '21' }],
  ],
  settings: [
    ['circle', { cx: '12', cy: '12', r: '3' }],
    ['circle', { cx: '12', cy: '12', r: '8' }],
    ['line', { x1: '12', y1: '1.5', x2: '12', y2: '4' }],
    ['line', { x1: '12', y1: '20', x2: '12', y2: '22.5' }],
    ['line', { x1: '1.5', y1: '12', x2: '4', y2: '12' }],
    ['line', { x1: '20', y1: '12', x2: '22.5', y2: '12' }],
  ],
  refresh: [
    ['path', { d: 'M20 12a8 8 0 1 1-2.34-5.66' }],
    ['polyline', { points: '20 4 20 9 15 9' }],
  ],
  user: [
    ['circle', { cx: '12', cy: '9', r: '3.5' }],
    ['path', { d: 'M5 20a7 7 0 0 1 14 0' }],
    ['circle', { cx: '12', cy: '12', r: '9.5' }],
  ],
  chevron: [['polyline', { points: '9 5 16 12 9 19' }]],
  external: [
    ['path', { d: 'M14 4h6v6' }],
    ['line', { x1: '20', y1: '4', x2: '11', y2: '13' }],
    ['path', { d: 'M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10' }],
  ],
  panel: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['line', { x1: '15', y1: '4', x2: '15', y2: '20' }],
  ],
  plus: [
    ['line', { x1: '12', y1: '5', x2: '12', y2: '19' }],
    ['line', { x1: '5', y1: '12', x2: '19', y2: '12' }],
  ],
  close: [
    ['line', { x1: '6', y1: '6', x2: '18', y2: '18' }],
    ['line', { x1: '18', y1: '6', x2: '6', y2: '18' }],
  ],
  moon: [['path', { d: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z' }]],
  dots: [
    ['circle', { cx: '12', cy: '5', r: '1.2' }],
    ['circle', { cx: '12', cy: '12', r: '1.2' }],
    ['circle', { cx: '12', cy: '19', r: '1.2' }],
  ],
  bolt: [['polygon', { points: '13 2 4 14 11 14 10 22 20 10 13 10 13 2' }]],
  building: [
    ['rect', { x: '4', y: '3', width: '16', height: '18', rx: '1.5' }],
    ['line', { x1: '8', y1: '7.5', x2: '11', y2: '7.5' }],
    ['line', { x1: '13', y1: '7.5', x2: '16', y2: '7.5' }],
    ['line', { x1: '8', y1: '12', x2: '11', y2: '12' }],
    ['line', { x1: '13', y1: '12', x2: '16', y2: '12' }],
    ['path', { d: 'M10 21v-4h4v4' }],
  ],

  // — tools —
  database: [
    ['ellipse', { cx: '12', cy: '6', rx: '8', ry: '3' }],
    ['path', { d: 'M4 6v12c0 1.66 3.58 3 8 3s8-1.34 8-3V6' }],
    ['path', { d: 'M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3' }],
  ],
  terminal: [
    ['rect', { x: '2.5', y: '4', width: '19', height: '16', rx: '2' }],
    ['polyline', { points: '7 10 10 12.5 7 15' }],
    ['line', { x1: '12.5', y1: '15.5', x2: '17', y2: '15.5' }],
  ],
  logs: [
    ['path', { d: 'M6 3h8l4 4v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z' }],
    ['polyline', { points: '14 3 14 7 18 7' }],
    ['line', { x1: '8.5', y1: '12', x2: '15', y2: '12' }],
    ['line', { x1: '8.5', y1: '16', x2: '15', y2: '16' }],
  ],
  api: [
    ['polyline', { points: '8 8 4 12 8 16' }],
    ['polyline', { points: '16 8 20 12 16 16' }],
    ['line', { x1: '13.5', y1: '5', x2: '10.5', y2: '19' }],
  ],
  metadata: [
    ['path', { d: 'M12 2.5 20.5 7v10L12 21.5 3.5 17V7z' }],
    ['polyline', { points: '3.5 7 12 11.5 20.5 7' }],
    ['line', { x1: '12', y1: '11.5', x2: '12', y2: '21.5' }],
  ],
  table: [
    ['rect', { x: '3', y: '4', width: '18', height: '16', rx: '2' }],
    ['line', { x1: '3', y1: '9.5', x2: '21', y2: '9.5' }],
    ['line', { x1: '9.5', y1: '9.5', x2: '9.5', y2: '20' }],
  ],
  flask: [
    ['path', { d: 'M9.5 3v6.5L4.5 18a2 2 0 0 0 1.7 3h11.6a2 2 0 0 0 1.7-3l-5-8.5V3' }],
    ['line', { x1: '8', y1: '3', x2: '16', y2: '3' }],
    ['line', { x1: '7.2', y1: '14.5', x2: '16.8', y2: '14.5' }],
  ],
  link: [
    ['path', { d: 'M10 14a4 4 0 0 0 5.66 0l3-3A4 4 0 0 0 13 5.34l-1.5 1.5' }],
    ['path', { d: 'M14 10a4 4 0 0 0-5.66 0l-3 3A4 4 0 0 0 11 18.66l1.5-1.5' }],
  ],
  check: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['polyline', { points: '8 12.5 11 15.5 16 9' }],
  ],
  clock: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['polyline', { points: '12 7 12 12 15.5 14' }],
  ],
  graph: [
    ['circle', { cx: '12', cy: '5', r: '2.5' }],
    ['circle', { cx: '5.5', cy: '18', r: '2.5' }],
    ['circle', { cx: '18.5', cy: '18', r: '2.5' }],
    ['line', { x1: '10.7', y1: '7.3', x2: '6.8', y2: '15.7' }],
    ['line', { x1: '13.3', y1: '7.3', x2: '17.2', y2: '15.7' }],
  ],
  gauge: [
    ['path', { d: 'M4 17a8 8 0 1 1 16 0' }],
    ['line', { x1: '12', y1: '17', x2: '16', y2: '11.5' }],
    ['circle', { cx: '12', cy: '17', r: '1.2' }],
  ],
  upload: [
    ['path', { d: 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15' }],
    ['polyline', { points: '8 8 12 4 16 8' }],
    ['line', { x1: '12', y1: '4', x2: '12', y2: '15' }],
  ],
  history: [
    ['path', { d: 'M4 12a8 8 0 1 0 2.34-5.66' }],
    ['polyline', { points: '4 4 4 9 9 9' }],
    ['polyline', { points: '12 8 12 12 15 14' }],
  ],
  code: [
    ['polyline', { points: '8.5 8 5 12 8.5 16' }],
    ['polyline', { points: '15.5 8 19 12 15.5 16' }],
  ],
  timer: [
    ['circle', { cx: '12', cy: '13', r: '8' }],
    ['line', { x1: '12', y1: '9', x2: '12', y2: '13' }],
    ['line', { x1: '9.5', y1: '2.5', x2: '14.5', y2: '2.5' }],
  ],
  server: [
    ['rect', { x: '3', y: '4', width: '18', height: '6', rx: '1.5' }],
    ['rect', { x: '3', y: '14', width: '18', height: '6', rx: '1.5' }],
    ['line', { x1: '7', y1: '7', x2: '7.01', y2: '7' }],
    ['line', { x1: '7', y1: '17', x2: '7.01', y2: '17' }],
  ],
  flow: [
    ['rect', { x: '3', y: '3', width: '7', height: '5', rx: '1' }],
    ['rect', { x: '14', y: '16', width: '7', height: '5', rx: '1' }],
    ['path', { d: 'M6.5 8v7a3 3 0 0 0 3 3h4.5' }],
  ],
  wave: [['path', { d: 'M2 12c2.5-5 5-5 7.5 0s5 5 7.5 0 3.5-3.5 5 0' }]],
  compare: [
    ['polyline', { points: '15 4 19 8 15 12' }],
    ['path', { d: 'M19 8H8a4 4 0 0 0-4 4' }],
    ['polyline', { points: '9 20 5 16 9 12' }],
    ['path', { d: 'M5 16h11a4 4 0 0 0 4-4' }],
  ],
  tag: [
    ['path', { d: 'M3 11V4.5A1.5 1.5 0 0 1 4.5 3H11l9.5 9.5a1.5 1.5 0 0 1 0 2.1l-6.4 6.4a1.5 1.5 0 0 1-2.1 0z' }],
    ['circle', { cx: '7.5', cy: '7.5', r: '1.3' }],
  ],
  alert: [
    ['path', { d: 'M12 3.5 22 20H2z' }],
    ['line', { x1: '12', y1: '10', x2: '12', y2: '14.5' }],
    ['line', { x1: '12', y1: '17', x2: '12.01', y2: '17' }],
  ],
  sparkle: [
    ['path', { d: 'M12 3 13.8 9.2 20 11l-6.2 1.8L12 19l-1.8-6.2L4 11l6.2-1.8z' }],
    ['line', { x1: '18.5', y1: '4', x2: '18.5', y2: '7' }],
    ['line', { x1: '17', y1: '5.5', x2: '20', y2: '5.5' }],
  ],
  rocket: [
    ['path', { d: 'M12 2c3.5 2.5 5.5 6.5 5.5 11l-2.5 3h-6L6.5 13C6.5 8.5 8.5 4.5 12 2z' }],
    ['circle', { cx: '12', cy: '9', r: '2' }],
    ['path', { d: 'M9 17c-1.5 1.5-1.5 3.5-1.5 5 1.5 0 3.5 0 5-1.5' }],
  ],
  chart: [
    ['line', { x1: '6', y1: '20', x2: '6', y2: '12' }],
    ['line', { x1: '12', y1: '20', x2: '12', y2: '5' }],
    ['line', { x1: '18', y1: '20', x2: '18', y2: '9' }],
  ],
  layers: [
    ['polygon', { points: '12 3 21 8 12 13 3 8 12 3' }],
    ['polyline', { points: '3 13 12 18 21 13' }],
  ],
  compass: [
    ['circle', { cx: '12', cy: '12', r: '9' }],
    ['polygon', { points: '15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5 15.5 8.5' }],
  ],
  heart: [
    ['path', { d: 'M12 20s-7-4.4-7-9.2A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.8C19 15.6 12 20 12 20z' }],
  ],
  star: [['polygon', { points: '12 3 14.6 9.1 21 9.7 16.2 14 17.6 20.3 12 17 6.4 20.3 7.8 14 3 9.7 9.4 9.1 12 3' }]],
  filter: [['polygon', { points: '3 4 21 4 14 12.5 14 20 10 18 10 12.5 3 4' }]],
  highlight: [
    ['path', { d: 'M14 3.5 20.5 10 11 19.5H4.5V13z' }],
    ['line', { x1: '3', y1: '22', x2: '21', y2: '22' }],
  ],
  clipboard: [
    ['rect', { x: '5', y: '4', width: '14', height: '17', rx: '2' }],
    ['rect', { x: '9', y: '2', width: '6', height: '4', rx: '1' }],
    ['line', { x1: '9', y1: '11', x2: '15', y2: '11' }],
    ['line', { x1: '9', y1: '15', x2: '13', y2: '15' }],
  ],
  wrench: [
    ['path', { d: 'M15.5 3a5.5 5.5 0 0 0-5 7.7L3.5 17.7a2 2 0 0 0 2.8 2.8l7-7A5.5 5.5 0 1 0 15.5 3z' }],
  ],
  record: [
    ['circle', { cx: '12', cy: '8', r: '3.5' }],
    ['path', { d: 'M5 20a7 7 0 0 1 14 0' }],
  ],
  export: [
    ['path', { d: 'M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15' }],
    ['polyline', { points: '8 8 12 12 16 8' }],
    ['line', { x1: '12', y1: '3', x2: '12', y2: '12' }],
  ],
  versions: [
    ['rect', { x: '8', y: '8', width: '13', height: '13', rx: '2' }],
    ['path', { d: 'M16 5H5a2 2 0 0 0-2 2v11' }],
  ],
  play: [['polygon', { points: '7 4 20 12 7 20 7 4' }]],
  save: [
    ['path', { d: 'M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' }],
    ['polyline', { points: '8 3 8 9 15 9' }],
    ['rect', { x: '7', y: '13', width: '10', height: '8' }],
  ],
  trash: [
    ['polyline', { points: '4 6 20 6' }],
    ['path', { d: 'M7 6V4h10v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14' }],
  ],
};

/** Every icon name the set defines. Exported so callers/tests can validate ids. */
export const ICON_NAMES: readonly string[] = Object.keys(ICONS);

/** Rendered when a name isn't in the set — a neutral dot, never a broken glyph. */
const FALLBACK: Shape[] = [['circle', { cx: '12', cy: '12', r: '3' }]];

/**
 * Feature registry id → icon name. Kept in lockstep with FEATURE_ICONS in
 * lib/feature-icons.ts; test/icons.test.ts fails if a feature gains an emoji
 * without a line icon, so the two can't drift.
 */
export const ICON_FOR_FEATURE: Record<string, string> = {
  // Flow tooling (Salesforce-page features)
  'setup-tabs': 'panel',
  'flow-list-search': 'filter',
  'canvas-search': 'highlight',
  'missing-descriptions': 'alert',
  'ai-assistant': 'sparkle',
  'api-name-generator': 'tag',
  'comparison-exporter': 'chart',
  'flow-version-manager': 'versions',
  'flow-trigger-explorer-enhancer': 'compass',
  'flow-health-check': 'heart',
  'scheduled-flow-explorer': 'clock',
  'trigger-conflicts': 'bolt',
  'subflow-graph': 'graph',
  'flow-deploy': 'rocket',
  'show-api-names': 'tag',
  'api-version-audit': 'chart',

  // Data & schema
  'soql-runner': 'database',
  'saved-soql': 'star',
  'inspect-record': 'record',
  'schema-browser': 'table',
  'field-impact': 'link',
  'field-creator': 'wrench',
  'data-import': 'upload',
  'export-for-prompt': 'clipboard',

  // Apex & logs
  'apex-anonymous': 'terminal',
  'apex-test-runner': 'flask',
  'apex-coverage': 'gauge',
  'debug-log-viewer': 'logs',
  'trace-flags': 'flow',

  // APIs & org
  'rest-explore': 'api',
  'soap-explore': 'api',
  'event-monitor': 'wave',
  'org-limits': 'gauge',
  'org-health': 'check',
  'org-switcher': 'building',

  // Metadata & bridge-backed
  'metadata-retrieve': 'metadata',
  'deploy-status': 'rocket',
  'metadata-scan': 'layers',
  'dependency-explorer': 'graph',
  'flow-quality': 'check',
  'quality-results': 'alert',
  'drift-check': 'wave',
  'org-compare': 'compare',
};

/**
 * Build an inline SVG icon. `size` is the rendered box; the viewBox is always 24
 * so the stroke weight scales with it.
 *
 * The element is `aria-hidden` by default: an icon next to a text label is
 * decorative, and an icon-only control must carry its own `aria-label` on the
 * button rather than on the glyph.
 */
export function icon(name: string, size = 20, doc: Document = document): SVGSVGElement {
  const svg = doc.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  // Records which glyph was resolved. Icons sit in flex rows where a fallback
  // dot and a real icon look similar at a glance, so this is what lets a test
  // (and a devtools inspect) tell "no icon mapped" from "icon rendered".
  svg.setAttribute('data-sfdt-icon', name);

  for (const [tag, attrs] of ICONS[name] ?? FALLBACK) {
    const shape = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.appendChild(shape);
  }
  return svg;
}

/** Icon for a feature registry id, falling back to the neutral dot. */
export function featureIcon(id: string, size = 20, doc: Document = document): SVGSVGElement {
  return icon(ICON_FOR_FEATURE[id] ?? '', size, doc);
}
