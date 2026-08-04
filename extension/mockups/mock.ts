// Design mockups — NOT shipped code.
//
// Full-fidelity build of the Stitch "High-Utility Developer Hub" dashboard and
// popup nav, rendered against the REAL extension palette. Nothing here is
// imported by the extension; WXT only scans entrypoints/, so this directory
// never reaches the store build (proven: build output is byte-identical with
// and without it).
//
// Everything here except the palette A/B and the fixtures is now REAL, imported
// live from lib/ — the design this mock argued for was adopted, so its former
// local copies of the token scales and the icon set were deleted rather than
// left to drift:
//   REAL      — the palette and the non-colour scales (space/radius/type/shadow)
//               from lib/tokens.ts.
//   REAL      — the component sheet from lib/ui-styles.ts (this file's own
//               `.card`/`.btn`/`.pill` rules predate it and are what the shipped
//               `.sfdt-`-prefixed components were derived from; they stay here
//               so the mock keeps rendering standalone).
//   REAL      — the line icons from lib/icons.ts.
//   REAL      — the theme mechanism: data-sfdt-theme on <html>, the same
//               attribute lib/theme.ts writes.
//   REAL      — tool labels and ordering from lib/feature-icons.ts.
//   A/B       — the Stitch Material-3 palette, behind the SLDS|Stitch toggle, so
//               the palette decision gets made by eye. See STITCH_PALETTE.
//               This is the one thing that was NOT adopted.
//   FIXTURE   — limits numbers, chart series, and the activity rows.
//
// House rules still apply: zero innerHTML, no raw hex outside the palette A/B
// block, foreground colours use the -text/-strong/-on-accent aliases.
//
// Run:  cd extension && npx vite mockups

import { SFDT_TOKENS_CSS, THEME_ATTR } from '../lib/tokens.ts';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.ts';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../lib/feature-icons.ts';
import { icon, featureIcon } from '../lib/icons.ts';

/** Attribute the mock's palette A/B writes to <html>. Mock-only. */
const PALETTE_ATTR = 'data-mock-palette';

// ---------------------------------------------------------------------------
// A/B: the Stitch Material-3 palette, mapped onto the --sfdt-color-* names
// ---------------------------------------------------------------------------
// Dark values come straight from the Stitch DESIGN.md frontmatter. Light values
// are derived from dashboard_light_mode_ide_style_refined/screen.png — Stitch
// only specified a dark scheme, and its light screen is white cards on a soft
// grey with a saturated blue accent, which is very close to SLDS already.
//
// Only the tokens this mock actually paints with are overridden; anything else
// falls through to the real palette. Toggle it with the SLDS|Stitch control to
// see whether the difference justifies re-tuning test/tokens.test.ts and
// re-rendering 40+ feature files.
const STITCH_PALETTE = `
:root[${PALETTE_ATTR}="stitch"] {
  --sfdt-color-bg: #f7f8fa;
  --sfdt-color-surface: #ffffff;
  --sfdt-color-surface-alt: #f2f4f7;
  --sfdt-color-surface-shade-2: #f7f8fa;
  --sfdt-color-surface-shade-3: #eef1f5;
  --sfdt-color-surface-shade-4: #e6eaf0;
  --sfdt-color-surface-shade-6: #dfe4ea;
  --sfdt-color-border: #dfe3e9;
  --sfdt-color-brand: #0b76d1;
  --sfdt-color-brand-active: #0a66b5;
  --sfdt-color-brand-deep: #ffffff;
  --sfdt-color-brand-text: #0b76d1;
  --sfdt-color-text-strong: #14181f;
  --sfdt-color-text: #3c4450;
  --sfdt-color-text-weak: #5b6675;
  --sfdt-color-text-muted: #78828f;
  --sfdt-color-text-icon: #8c95a1;
  --sfdt-color-warning: #d5850b;
  --sfdt-color-warning-text: #92610a;
}
:root[${PALETTE_ATTR}="stitch"][${THEME_ATTR}="dark"] {
  --sfdt-color-bg: #131313;
  --sfdt-color-surface: #201f1f;
  --sfdt-color-surface-alt: #0e0e0e;
  --sfdt-color-surface-shade-2: #1c1b1b;
  --sfdt-color-surface-shade-3: #2a2a2a;
  --sfdt-color-surface-shade-4: #353534;
  --sfdt-color-surface-shade-6: #393939;
  --sfdt-color-border: #3e4850;
  --sfdt-color-brand: #00a1e0;
  --sfdt-color-brand-active: #84cfff;
  --sfdt-color-brand-deep: #0e0e0e;
  --sfdt-color-brand-text: #84cfff;
  --sfdt-color-text-strong: #e5e2e1;
  --sfdt-color-text: #e5e2e1;
  --sfdt-color-text-weak: #bdc8d1;
  --sfdt-color-text-muted: #88929b;
  --sfdt-color-text-icon: #88929b;
  --sfdt-color-on-accent: #00344c;
  --sfdt-color-warning: #ffb867;
  --sfdt-color-warning-text: #ffb867;
  --sfdt-color-success-text: #7ee2a8;
  --sfdt-color-error-text: #ffb4ab;
}
`;

const STYLES = `
*, *::before, *::after { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  font: var(--sfdt-type-body-md);
  background: var(--sfdt-color-bg);
  color: var(--sfdt-color-text);
  -webkit-font-smoothing: antialiased;
}
button { font: inherit; color: inherit; cursor: pointer; }
::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--sfdt-color-surface-shade-6); border-radius: var(--sfdt-radius-pill); }
::-webkit-scrollbar-track { background: transparent; }

/* --- mock chrome (not part of any design) --------------------------------- */
#mock-bar {
  display: flex; align-items: center; gap: var(--sfdt-space-3);
  padding: var(--sfdt-space-2) var(--sfdt-space-4);
  background: var(--sfdt-color-surface-alt);
  border-bottom: 1px solid var(--sfdt-color-border);
  height: 41px;
}
#mock-bar .brand { font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps); color: var(--sfdt-color-text-muted); }
#mock-bar .spacer { margin-left: auto; }
.seg { display: flex; border: 1px solid var(--sfdt-color-border); border-radius: var(--sfdt-radius); overflow: hidden; }
.seg button { padding: 4px 12px; border: 0; background: var(--sfdt-color-surface); font: var(--sfdt-type-body-sm); }
.seg button[aria-pressed="true"] { background: var(--sfdt-color-brand); color: var(--sfdt-color-on-accent); }
.seg button:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: -2px; }

/* --- shared primitives ---------------------------------------------------- */
.card {
  background: var(--sfdt-color-surface);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-xl);
  box-shadow: var(--sfdt-shadow-1);
}
.card-head {
  display: flex; align-items: center; gap: var(--sfdt-space-2);
  padding: var(--sfdt-space-5) var(--sfdt-space-5) var(--sfdt-space-4);
}
.card-head h2 { font: var(--sfdt-type-headline-md); margin: 0; color: var(--sfdt-color-text-strong); }
.card-head .actions { margin-left: auto; display: flex; gap: var(--sfdt-space-2); }
.card-head .lead { color: var(--sfdt-color-brand-text); display: flex; }
.caps {
  font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps);
  color: var(--sfdt-color-text-muted); text-transform: uppercase;
}
.mono { font: var(--sfdt-type-code-sm); }
.pill {
  display: inline-flex; align-items: center; padding: 3px 10px;
  border-radius: var(--sfdt-radius-pill);
  font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase;
}
.pill.success { background: var(--sfdt-color-success-bg); color: var(--sfdt-color-success-text); }
.pill.running { background: var(--sfdt-color-warning-bg); color: var(--sfdt-color-warning-text); }
.pill.failed  { background: var(--sfdt-color-error-bg);   color: var(--sfdt-color-error-text); }
.meter { height: 5px; border-radius: var(--sfdt-radius-pill); background: var(--sfdt-color-surface-shade-6); overflow: hidden; }
.meter > i { display: block; height: 100%; border-radius: var(--sfdt-radius-pill); }
.btn {
  display: inline-flex; align-items: center; gap: var(--sfdt-space-2);
  padding: 7px 14px; border-radius: var(--sfdt-radius-md);
  border: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-surface);
  color: var(--sfdt-color-brand-text);
  font: var(--sfdt-type-body-sm); font-weight: 600;
}
.btn:hover { background: var(--sfdt-color-surface-shade-2); }
.btn.primary { background: var(--sfdt-color-brand); border-color: var(--sfdt-color-brand); color: var(--sfdt-color-on-accent); }
.btn.primary:hover { background: var(--sfdt-color-brand-active); }
.btn.ghost { border-color: transparent; background: none; color: var(--sfdt-color-text-icon); padding: 6px; }
.btn.ghost:hover { background: var(--sfdt-color-surface-shade-3); color: var(--sfdt-color-text-strong); }
.btn:focus-visible { outline: 2px solid var(--sfdt-color-info); outline-offset: 2px; }
.dot { width: 8px; height: 8px; border-radius: var(--sfdt-radius-pill); display: inline-block; flex: 0 0 auto; }

/* --- dashboard shell ------------------------------------------------------ */
#dash { display: flex; height: calc(100vh - 41px); }

#dash .sidebar {
  width: var(--sfdt-sidebar-w); flex: 0 0 auto;
  display: flex; flex-direction: column;
  background: var(--sfdt-color-surface-alt);
  border-right: 1px solid var(--sfdt-color-border);
}
#dash .sidebar .brandblock { padding: var(--sfdt-space-5) var(--sfdt-space-5) var(--sfdt-space-4); }
#dash .sidebar .brandblock .name {
  display: flex; align-items: center; gap: var(--sfdt-space-2);
  font: var(--sfdt-type-headline-lg); color: var(--sfdt-color-brand-text);
}
#dash .sidebar .brandblock .sub { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-muted); margin-top: 2px; }
#dash .sidebar .nav { flex: 1; overflow-y: auto; padding: 0 var(--sfdt-space-2) var(--sfdt-space-2); }
#dash .sidebar .group { padding: var(--sfdt-space-4) var(--sfdt-space-3) var(--sfdt-space-1); }
#dash .sidebar .item {
  display: flex; align-items: center; gap: var(--sfdt-space-3);
  width: 100%; padding: 10px var(--sfdt-space-3);
  border: 0; border-left: 3px solid transparent;
  border-radius: 0 var(--sfdt-radius-md) var(--sfdt-radius-md) 0;
  background: none; text-align: left;
  font: var(--sfdt-type-body-md);
  color: var(--sfdt-color-text);
}
#dash .sidebar .item:hover { background: var(--sfdt-color-surface-shade-3); }
#dash .sidebar .item[aria-current="page"] {
  background: var(--sfdt-color-surface-shade-3);
  border-left-color: var(--sfdt-color-brand);
  color: var(--sfdt-color-brand-text);
  font-weight: 600;
}
#dash .sidebar .item .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#dash .sidebar .item .count { margin-left: auto; }
#dash .sidebar .foot { padding: var(--sfdt-space-4); border-top: 1px solid var(--sfdt-color-border); display: flex; flex-direction: column; gap: var(--sfdt-space-1); }
#dash .sidebar .foot .btn { justify-content: center; width: 100%; margin-bottom: var(--sfdt-space-2); }
#dash .sidebar .foot .item { padding: 8px var(--sfdt-space-2); border-radius: var(--sfdt-radius-md); border-left: 0; color: var(--sfdt-color-text-weak); }

#dash .body { flex: 1; min-width: 0; display: flex; flex-direction: column; }

#dash .topbar {
  height: var(--sfdt-topbar-h); flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sfdt-space-3);
  padding: 0 var(--sfdt-space-6);
  background: var(--sfdt-color-surface);
  border-bottom: 1px solid var(--sfdt-color-border);
}
#dash .topbar .org { font: var(--sfdt-type-headline-md); color: var(--sfdt-color-text-strong); }
#dash .topbar .release {
  padding: 2px 10px; border-radius: var(--sfdt-radius);
  background: var(--sfdt-color-warning-bg); color: var(--sfdt-color-warning-text);
  font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps);
}
#dash .topbar .search {
  margin-left: auto; display: flex; align-items: center; gap: var(--sfdt-space-2);
  width: min(340px, 34vw); padding: 7px var(--sfdt-space-3);
  background: var(--sfdt-color-surface-shade-2);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-md);
  color: var(--sfdt-color-text-icon);
  font: var(--sfdt-type-body-sm);
}
#dash .topbar .switch { color: var(--sfdt-color-brand-text); font-weight: 600; font-size: 14px; border: 0; background: none; }

#dash .main { flex: 1; min-width: 0; overflow-y: auto; padding: var(--sfdt-space-6); }

#dash .greeting { display: flex; align-items: flex-end; gap: var(--sfdt-space-4); margin-bottom: var(--sfdt-space-6); }
#dash .greeting h1 { font: var(--sfdt-type-display); margin: 0; color: var(--sfdt-color-text-strong); letter-spacing: -0.01em; }
#dash .greeting p { margin: 4px 0 0; color: var(--sfdt-color-text-weak); }
#dash .greeting .load { margin-left: auto; width: 200px; }
#dash .greeting .load .row { display: flex; align-items: baseline; gap: var(--sfdt-space-2); margin-bottom: 6px; }
#dash .greeting .load .row .pct { margin-left: auto; font: var(--sfdt-type-headline-md); color: var(--sfdt-color-brand-text); }

#dash .bento { display: grid; grid-template-columns: minmax(0, 2.1fr) minmax(260px, 1fr); gap: var(--sfdt-space-4); margin-bottom: var(--sfdt-space-4); align-items: start; }
@media (max-width: 1040px) { #dash .bento { grid-template-columns: minmax(0, 1fr); } }

#dash .tiles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sfdt-space-3); padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); }
#dash .tile {
  background: var(--sfdt-color-surface-shade-2);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-lg);
  padding: var(--sfdt-space-4);
}
#dash .tile .caps { display: block; margin-bottom: var(--sfdt-space-3); }
#dash .tile .value { font: var(--sfdt-type-metric); color: var(--sfdt-color-text-strong); letter-spacing: -0.02em; }
#dash .tile .value small { font: var(--sfdt-type-body-md); color: var(--sfdt-color-text-weak); letter-spacing: 0; }
#dash .tile .meter { margin-top: var(--sfdt-space-3); }
#dash .tile .ok { display: flex; align-items: center; gap: var(--sfdt-space-2); color: var(--sfdt-color-success-text); font: var(--sfdt-type-headline-md); }

#dash .chart { padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); border-top: 1px solid var(--sfdt-color-border); padding-top: var(--sfdt-space-5); margin-top: var(--sfdt-space-1); }
#dash .chart .head { display: flex; align-items: center; margin-bottom: var(--sfdt-space-4); }
#dash .chart .legend { margin-left: auto; display: flex; gap: var(--sfdt-space-4); font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak); }
#dash .chart .legend span { display: flex; align-items: center; gap: 6px; }
#dash .chart .plot { display: flex; align-items: flex-end; gap: var(--sfdt-space-2); height: 140px; }
#dash .chart .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; border-radius: var(--sfdt-radius) var(--sfdt-radius) 0 0; overflow: hidden; }
#dash .chart .bar i { display: block; }

#dash .quick { display: flex; flex-direction: column; gap: var(--sfdt-space-2); padding: 0 var(--sfdt-space-5) var(--sfdt-space-5); }
#dash .quick .action {
  display: flex; align-items: center; gap: var(--sfdt-space-3);
  padding: var(--sfdt-space-3);
  background: var(--sfdt-color-surface-shade-2);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-lg);
  width: 100%; text-align: left;
}
#dash .quick .action:hover { border-color: var(--sfdt-color-brand); }
#dash .quick .action .glyph {
  width: 36px; height: 36px; flex: 0 0 auto;
  display: flex; align-items: center; justify-content: center;
  background: var(--sfdt-color-surface-shade-4);
  border-radius: var(--sfdt-radius-md);
  color: var(--sfdt-color-text-weak);
}
#dash .quick .action .label { font: var(--sfdt-type-body-md); font-weight: 600; color: var(--sfdt-color-text-strong); }
#dash .quick .action .chev { margin-left: auto; color: var(--sfdt-color-text-icon); display: flex; }
#dash .quick .note {
  display: flex; gap: var(--sfdt-space-3); align-items: flex-start;
  padding: var(--sfdt-space-3);
  background: var(--sfdt-color-surface-shade-3);
  border-radius: var(--sfdt-radius-lg);
  font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak);
}
#dash .quick .note .glyph { color: var(--sfdt-color-brand-text); display: flex; }

#dash table { width: 100%; border-collapse: collapse; }
#dash th {
  text-align: left; padding: var(--sfdt-space-2) var(--sfdt-space-5);
  font: var(--sfdt-type-label-caps); letter-spacing: var(--sfdt-tracking-caps);
  text-transform: uppercase; color: var(--sfdt-color-text-muted);
  border-top: 1px solid var(--sfdt-color-border);
  border-bottom: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-surface-shade-2);
}
#dash td { padding: var(--sfdt-space-3) var(--sfdt-space-5); border-bottom: 1px solid var(--sfdt-color-border); }
#dash tbody tr:last-child td { border-bottom: 0; }
#dash tbody tr:hover { background: var(--sfdt-color-surface-shade-2); }
#dash td.time, #dash td.resource { font: var(--sfdt-type-code-sm); color: var(--sfdt-color-text-weak); }
#dash td.actor { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak); }
#dash td .act { display: flex; align-items: center; gap: var(--sfdt-space-2); color: var(--sfdt-color-text-strong); font-weight: 600; font-size: 14px; }
#dash td .act .glyph { color: var(--sfdt-color-brand-text); display: flex; }

#dash .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sfdt-space-4); margin-top: var(--sfdt-space-4); }
#dash .stats .card { display: flex; align-items: center; gap: var(--sfdt-space-4); padding: var(--sfdt-space-5); }
#dash .stats .glyph { width: 44px; height: 44px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; border-radius: var(--sfdt-radius-lg); background: var(--sfdt-color-surface-shade-4); color: var(--sfdt-color-brand-text); }
#dash .stats .value { font: var(--sfdt-type-headline-lg); color: var(--sfdt-color-text-strong); }

#dash .statusbar {
  flex: 0 0 auto;
  display: flex; align-items: center; gap: var(--sfdt-space-5);
  padding: var(--sfdt-space-2) var(--sfdt-space-6);
  border-top: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-surface);
  font: var(--sfdt-type-code-sm); color: var(--sfdt-color-text-weak);
}
#dash .statusbar .grow { margin-left: auto; }
#dash .statusbar span { display: flex; align-items: center; gap: 6px; }

/* --- popup comparison ----------------------------------------------------- */
#popups { display: flex; gap: var(--sfdt-space-8); padding: var(--sfdt-space-8); align-items: flex-start; flex-wrap: wrap; }
#popups .col { display: flex; flex-direction: column; gap: var(--sfdt-space-2); }
.popup {
  background: var(--sfdt-color-surface);
  border: 1px solid var(--sfdt-color-border);
  border-radius: var(--sfdt-radius-xl);
  box-shadow: var(--sfdt-shadow-2);
  overflow: hidden;
}
.popup.current { width: 300px; padding: 14px 16px; border-radius: var(--sfdt-radius); }
.popup.proposed { width: 320px; }
.popup h1 { font: var(--sfdt-type-headline-md); margin: 0 0 10px; color: var(--sfdt-color-text-strong); }
.popup .org { font: var(--sfdt-type-code-sm); color: var(--sfdt-color-text); margin-bottom: var(--sfdt-space-2); word-break: break-all; }
.popup .status { display: flex; align-items: center; gap: var(--sfdt-space-2); padding: 3px 0; font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak); }
.popup .stack { display: flex; flex-direction: column; gap: 6px; margin: var(--sfdt-space-3) 0; }
.popup .stack .btn { width: 100%; justify-content: center; padding: 8px 12px; border-radius: var(--sfdt-radius); font-weight: 400; }
.popup .version { font: var(--sfdt-type-code-sm); color: var(--sfdt-color-text-icon); text-align: right; }

.popup.proposed .head {
  display: flex; align-items: center; gap: var(--sfdt-space-2);
  padding: var(--sfdt-space-4) var(--sfdt-space-4) var(--sfdt-space-3);
  border-bottom: 1px solid var(--sfdt-color-border);
  color: var(--sfdt-color-brand-text);
}
.popup.proposed .head h1 { margin: 0; color: var(--sfdt-color-text-strong); }
.popup.proposed .strip { padding: var(--sfdt-space-3) var(--sfdt-space-4); background: var(--sfdt-color-surface-shade-2); border-bottom: 1px solid var(--sfdt-color-border); }
.popup.proposed .list { max-height: 340px; overflow-y: auto; padding: var(--sfdt-space-2) 0; }
.popup.proposed .item {
  display: flex; align-items: center; gap: var(--sfdt-space-3);
  width: 100%; padding: 9px var(--sfdt-space-4);
  border: 0; background: none; text-align: left;
  font: var(--sfdt-type-body-md);
  color: var(--sfdt-color-text);
}
.popup.proposed .item .glyph { color: var(--sfdt-color-text-icon); display: flex; }
.popup.proposed .item:hover { background: var(--sfdt-color-surface-shade-2); }
.popup.proposed .item:hover .glyph { color: var(--sfdt-color-brand-text); }
.popup.proposed .item.accent { color: var(--sfdt-color-brand-text); font-weight: 600; }
.popup.proposed .item.accent .glyph { color: var(--sfdt-color-brand-text); }
.popup.proposed .sep { height: 1px; background: var(--sfdt-color-border); margin: var(--sfdt-space-2) 0; }
.popup.proposed .foot {
  display: flex; align-items: center; gap: var(--sfdt-space-2);
  padding: 10px var(--sfdt-space-4);
  border-top: 1px solid var(--sfdt-color-border);
  background: var(--sfdt-color-surface-alt);
  color: var(--sfdt-color-brand-text); font-weight: 600; font-size: 14px;
}
.popup.proposed .foot .glyph { display: flex; }
.popup.proposed .foot .grow { margin-left: auto; font-weight: 400; }

#notes { padding: 0 var(--sfdt-space-8) var(--sfdt-space-8); max-width: 760px; }
#notes li { font: var(--sfdt-type-body-sm); color: var(--sfdt-color-text-weak); margin-bottom: var(--sfdt-space-2); }
#notes li strong { color: var(--sfdt-color-text-strong); }
`;

// ---------------------------------------------------------------------------
// DOM helpers — createElement + textContent only (extension rule #1).
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const child of children) {
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function glyph(name: string, size = 20, cls = 'glyph'): HTMLElement {
  return el('span', { class: cls, 'aria-hidden': 'true' }, icon(name, size));
}

/** A colour dot that is never the only signal — text always carries the meaning. */
function dot(colour: string): HTMLElement {
  const d = el('span', { class: 'dot', 'aria-hidden': 'true' });
  d.style.background = colour;
  return d;
}

function meter(pct: number, colour: string): HTMLElement {
  const bar = el('div', { class: 'meter' });
  const fill = el('i');
  fill.style.width = `${Math.round(pct * 100)}%`;
  fill.style.background = colour;
  bar.appendChild(fill);
  return bar;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// ponytail: production reads these from features/org-limits.ts — shapeLimits()
// and bandFor() already return {used, max, pct} and a green/amber/red band.
// Importing that module here would drag in chrome.* deps, so the mock inlines
// the shape and duplicates the three-line band rule.
interface LimitRow {
  name: string;
  used: number;
  max: number;
  pct: number;
}

const LIMIT_FIXTURES: LimitRow[] = [
  { name: 'DailyApiRequests', used: 12_432, max: 50_000, pct: 0.249 },
  { name: 'DataStorageMB', used: 1843, max: 5120, pct: 0.36 },
  { name: 'DailyAsyncApexExecutions', used: 187_400, max: 250_000, pct: 0.75 },
  { name: 'DailyBulkApiBatches', used: 9420, max: 10_000, pct: 0.942 },
  { name: 'HourlyTimeBasedWorkflow', used: 120, max: 1000, pct: 0.12 },
];

function bandColour(pct: number): string {
  if (pct >= 0.9) return 'var(--sfdt-color-error)';
  if (pct >= 0.7) return 'var(--sfdt-color-warning)';
  return 'var(--sfdt-color-success)';
}

/** Query-performance series: [soql ms, dml ms] per bucket. */
const CHART_FIXTURES: Array<[number, number]> = [
  [42, 18],
  [61, 22],
  [55, 15],
  [78, 31],
  [46, 12],
  [33, 9],
  [96, 28],
  [70, 19],
  [51, 14],
  [58, 26],
  [88, 21],
  [49, 11],
];

/**
 * The Recent Activity contract. The extension has no activity log today —
 * lib/palette-recents.ts stores command ids only (no timestamp, resource or
 * status), so it cannot fill this table. Phase 2 adds lib/activity-log.ts, a
 * bounded chrome.storage.local ring buffer written by soql-runner,
 * apex-anonymous, metadata-retrieve and the bridge tools. This interface is the
 * contract that store will satisfy; the rows below are placeholder data.
 */
interface ActivityEntry {
  ts: number;
  featureId: string;
  action: string;
  actor: string;
  resource?: string;
  status: 'success' | 'running' | 'failed';
}

// Fixed offsets from a fixed base so the mock renders identically on every load.
const BASE_TS = Date.UTC(2026, 6, 30, 14, 24, 2);

const ACTIVITY_FIXTURES: ActivityEntry[] = [
  {
    ts: BASE_TS,
    featureId: 'soql-runner',
    action: 'SOQL Query',
    actor: 'j.doe@prod-org.com',
    resource: 'SELECT Id, Name FROM Account …',
    status: 'success',
  },
  {
    ts: BASE_TS - 8 * 60_000,
    featureId: 'apex-anonymous',
    action: 'Apex Execution',
    actor: 'admin_system@prod.io',
    resource: 'BatchLeadScoring.cls',
    status: 'running',
  },
  {
    ts: BASE_TS - 26 * 60_000,
    featureId: 'metadata-retrieve',
    action: 'Deployment',
    actor: 'ci-runner-v2',
    resource: 'package.xml (v65.0)',
    status: 'failed',
  },
  {
    ts: BASE_TS - 41 * 60_000,
    featureId: 'schema-browser',
    action: 'Describe',
    actor: 'j.doe@prod-org.com',
    resource: 'Account, Contact, Opportunity',
    status: 'success',
  },
  {
    ts: BASE_TS - 55 * 60_000,
    featureId: 'flow-quality',
    action: 'Flow Quality Scan',
    actor: 'j.doe@prod-org.com',
    resource: '42 flows · 7 findings',
    status: 'success',
  },
];

const STATUS_LABEL: Record<ActivityEntry['status'], string> = {
  success: 'Success',
  running: 'Running',
  failed: 'Failed',
};

/**
 * Curated primary nav — the Stitch sidebar carries SEVEN items, not the full
 * WORKSPACE_TOOLS list. Dumping all twenty is most of why the current Workspace
 * sidebar reads as a wall of text. Everything else lives behind "All tools".
 */
const PRIMARY_NAV: Array<{ id: string; label: string; iconName: string }> = [
  { id: 'overview', label: 'Overview', iconName: 'grid' },
  { id: 'soql-runner', label: 'SOQL Editor', iconName: 'database' },
  { id: 'apex-anonymous', label: 'Apex Runner', iconName: 'terminal' },
  { id: 'debug-log-viewer', label: 'Log Viewer', iconName: 'logs' },
  { id: 'rest-explore', label: 'API Explorer', iconName: 'api' },
  { id: 'schema-browser', label: 'Schema', iconName: 'table' },
  { id: 'metadata-retrieve', label: 'Metadata', iconName: 'metadata' },
];

const QUICK_ACTIONS: Array<{ id: string; sub: string }> = [
  { id: 'inspect-record', sub: 'Describe metadata' },
  { id: 'data-import', sub: 'Bulk API 2.0' },
  { id: 'apex-anonymous', sub: 'Apex scripting' },
  { id: 'debug-log-viewer', sub: 'Real-time streaming' },
];

const ORG_HOST = 'acme.my.salesforce.com';

function hhmmss(ts: number): string {
  return new Date(ts).toISOString().slice(11, 19);
}

function labelFor(id: string): string {
  return FEATURE_ICONS[id]?.label ?? id;
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function tile(label: string, body: HTMLElement, bar: HTMLElement | null): HTMLElement {
  const box = el('div', { class: 'tile' });
  box.appendChild(el('span', { class: 'caps' }, label));
  box.appendChild(body);
  if (bar) box.appendChild(bar);
  return box;
}

function metric(value: string, unit: string): HTMLElement {
  const v = el('div', { class: 'value' }, value);
  if (unit) v.appendChild(el('small', {}, ` ${unit}`));
  return v;
}

function chart(): HTMLElement {
  const wrap = el('div', { class: 'chart' });

  const head = el('div', { class: 'head' });
  head.appendChild(el('span', { class: 'caps' }, 'Query performance (ms)'));
  const legend = el('div', { class: 'legend' });
  const soql = el('span');
  soql.appendChild(dot('var(--sfdt-color-brand)'));
  soql.appendChild(document.createTextNode('SOQL'));
  const dml = el('span');
  dml.appendChild(dot('var(--sfdt-color-warning)'));
  dml.appendChild(document.createTextNode('DML'));
  legend.appendChild(soql);
  legend.appendChild(dml);
  head.appendChild(legend);
  wrap.appendChild(head);

  const peak = Math.max(...CHART_FIXTURES.map(([a, b]) => a + b));
  const plot = el('div', { class: 'plot', role: 'img', 'aria-label': 'Query performance over the last 12 buckets' });
  for (const [soqlMs, dmlMs] of CHART_FIXTURES) {
    const bar = el('div', { class: 'bar' });
    bar.style.height = `${Math.round(((soqlMs + dmlMs) / peak) * 100)}%`;
    const top = el('i');
    top.style.height = `${Math.round((dmlMs / (soqlMs + dmlMs)) * 100)}%`;
    top.style.background = 'var(--sfdt-color-warning)';
    const bottom = el('i');
    bottom.style.flex = '1';
    bottom.style.background = 'var(--sfdt-color-brand)';
    bar.appendChild(top);
    bar.appendChild(bottom);
    plot.appendChild(bar);
  }
  wrap.appendChild(plot);
  return wrap;
}

function healthCard(): HTMLElement {
  const card = el('div', { class: 'card' });

  const head = el('div', { class: 'card-head' });
  head.appendChild(glyph('gauge', 20, 'lead'));
  head.appendChild(el('h2', {}, 'System health overview'));
  const actions = el('div', { class: 'actions' });
  const more = el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'More' });
  more.appendChild(icon('dots', 18));
  actions.appendChild(more);
  head.appendChild(actions);
  card.appendChild(head);

  const tiles = el('div', { class: 'tiles' });
  tiles.appendChild(tile('API requests (24h)', metric('12.4k', '/ 50k'), meter(0.249, bandColour(0.249))));
  tiles.appendChild(tile('Data storage', metric('1.8', 'GB / 5 GB'), meter(0.36, bandColour(0.36))));

  const health = el('div', { class: 'ok' });
  health.appendChild(icon('check', 24));
  health.appendChild(el('span', {}, 'Optimal'));
  const risk = el('div');
  risk.appendChild(health);
  risk.appendChild(el('div', { class: 'caps' }, '1 of 5 limits at risk'));
  tiles.appendChild(tile('Org health', risk, null));
  card.appendChild(tiles);

  card.appendChild(chart());
  return card;
}

function limitsCard(): HTMLElement {
  const card = el('div', { class: 'card' });
  const head = el('div', { class: 'card-head' });
  head.appendChild(glyph('server', 20, 'lead'));
  head.appendChild(el('h2', {}, 'Governor limits'));
  card.appendChild(head);

  const table = el('table');
  const tbody = el('tbody');
  for (const row of [...LIMIT_FIXTURES].sort((a, b) => b.pct - a.pct)) {
    const tr = el('tr');
    tr.appendChild(el('td', {}, el('span', { class: 'act' }, row.name)));
    const bar = el('td');
    bar.style.width = '140px';
    bar.appendChild(meter(row.pct, bandColour(row.pct)));
    tr.appendChild(bar);
    const num = el('td', { class: 'resource' },
      `${row.used.toLocaleString('en-GB')} / ${row.max.toLocaleString('en-GB')}`);
    num.style.textAlign = 'right';
    tr.appendChild(num);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

function quickActionsCard(): HTMLElement {
  const card = el('div', { class: 'card' });
  const head = el('div', { class: 'card-head' });
  head.appendChild(glyph('bolt', 20, 'lead'));
  head.appendChild(el('h2', {}, 'Quick actions'));
  card.appendChild(head);

  const list = el('div', { class: 'quick' });
  for (const { id, sub } of QUICK_ACTIONS) {
    const action = el('button', { class: 'action', type: 'button' });
    action.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, featureIcon(id, 20)));
    const text = el('span');
    text.appendChild(el('div', { class: 'label' }, labelFor(id)));
    text.appendChild(el('div', { class: 'caps' }, sub));
    action.appendChild(text);
    action.appendChild(el('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chevron', 18)));
    list.appendChild(action);
  }

  const note = el('div', { class: 'note' });
  note.appendChild(glyph('history', 18));
  note.appendChild(
    el('span', {}, 'Tool tabs persist across org switches. Last synced 14:02:11.'),
  );
  list.appendChild(note);

  card.appendChild(list);
  return card;
}

function activityCard(): HTMLElement {
  const card = el('div', { class: 'card' });

  const head = el('div', { class: 'card-head' });
  head.appendChild(glyph('history', 20, 'lead'));
  head.appendChild(el('h2', {}, 'Recent activity'));
  const actions = el('div', { class: 'actions' });
  actions.appendChild(el('button', { class: 'btn', type: 'button' }, 'Filter'));
  actions.appendChild(el('button', { class: 'btn primary', type: 'button' }, 'Export CSV'));
  head.appendChild(actions);
  card.appendChild(head);

  const table = el('table');
  const thead = el('thead');
  const hrow = el('tr');
  for (const h of ['Time', 'Action', 'User / actor', 'Resource', 'Status']) {
    hrow.appendChild(el('th', {}, h));
  }
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const entry of ACTIVITY_FIXTURES) {
    const tr = el('tr');
    tr.appendChild(el('td', { class: 'time' }, hhmmss(entry.ts)));

    const act = el('span', { class: 'act' });
    act.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, featureIcon(entry.featureId, 18)));
    act.appendChild(document.createTextNode(entry.action));
    tr.appendChild(el('td', {}, act));

    tr.appendChild(el('td', { class: 'actor' }, entry.actor));
    tr.appendChild(el('td', { class: 'resource' }, entry.resource ?? '—'));

    const status = el('td');
    status.appendChild(el('span', { class: `pill ${entry.status}` }, STATUS_LABEL[entry.status]));
    tr.appendChild(status);

    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  card.appendChild(table);
  return card;
}

function statsRow(): HTMLElement {
  const wrap = el('div', { class: 'stats' });
  const stats: Array<[string, string, string]> = [
    ['code', 'Total Apex classes', '1,248'],
    ['timer', 'Avg response time', '142 ms'],
    ['server', 'Metadata cache', '12.5 MB'],
  ];
  for (const [iconName, label, value] of stats) {
    const card = el('div', { class: 'card' });
    card.appendChild(glyph(iconName, 22));
    const text = el('div');
    text.appendChild(el('div', { class: 'caps' }, label));
    text.appendChild(el('div', { class: 'value' }, value));
    card.appendChild(text);
    wrap.appendChild(card);
  }
  return wrap;
}

function sidebar(): HTMLElement {
  const side = el('nav', { class: 'sidebar', 'aria-label': 'Workspace navigation' });

  const brand = el('div', { class: 'brandblock' });
  const name = el('div', { class: 'name' });
  name.appendChild(icon('bolt', 22));
  name.appendChild(el('span', {}, 'SFDT Workspace'));
  brand.appendChild(name);
  brand.appendChild(el('div', { class: 'sub' }, 'Salesforce developer tools'));
  side.appendChild(brand);

  const nav = el('div', { class: 'nav' });
  for (const item of PRIMARY_NAV) {
    const attrs: Record<string, string> = { class: 'item', type: 'button' };
    if (item.id === 'overview') attrs['aria-current'] = 'page';
    const b = el('button', attrs);
    b.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon(item.iconName, 20)));
    b.appendChild(el('span', { class: 'label' }, item.label));
    nav.appendChild(b);
  }

  nav.appendChild(el('div', { class: 'group caps' }, 'More'));
  const all = el('button', { class: 'item', type: 'button' });
  all.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('grid', 20)));
  all.appendChild(el('span', { class: 'label' }, 'All tools'));
  all.appendChild(el('span', { class: 'count caps' }, String(WORKSPACE_TOOLS.length)));
  nav.appendChild(all);
  side.appendChild(nav);

  const foot = el('div', { class: 'foot' });
  const newTab = el('button', { class: 'btn primary', type: 'button' });
  newTab.appendChild(icon('plus', 18));
  newTab.appendChild(el('span', {}, 'New workspace'));
  foot.appendChild(newTab);

  const theme = el('button', { class: 'item', type: 'button' });
  theme.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('moon', 18)));
  theme.appendChild(el('span', { class: 'label' }, 'Theme'));
  foot.appendChild(theme);

  const settings = el('button', { class: 'item', type: 'button' });
  settings.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('settings', 18)));
  settings.appendChild(el('span', { class: 'label' }, 'Settings'));
  foot.appendChild(settings);
  side.appendChild(foot);

  return side;
}

function topbar(): HTMLElement {
  const bar = el('div', { class: 'topbar' });
  bar.appendChild(el('span', { class: 'org' }, 'Acme Production'));
  bar.appendChild(el('span', { class: 'release' }, "Summer '26"));

  const search = el('div', { class: 'search' });
  search.appendChild(icon('search', 16));
  search.appendChild(el('span', {}, 'Search metadata, logs, objects…'));
  bar.appendChild(search);

  bar.appendChild(el('button', { class: 'switch', type: 'button' }, 'Switch org'));

  const refresh = el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Refresh' });
  refresh.appendChild(icon('refresh', 20));
  bar.appendChild(refresh);

  const account = el('button', { class: 'btn ghost', type: 'button', 'aria-label': 'Account' });
  account.appendChild(icon('user', 20));
  bar.appendChild(account);
  return bar;
}

function renderDashboard(root: HTMLElement): void {
  const dash = el('div', { id: 'dash' });
  dash.appendChild(sidebar());

  const body = el('div', { class: 'body' });
  body.appendChild(topbar());

  const main = el('div', { class: 'main' });

  const greeting = el('div', { class: 'greeting' });
  const heading = el('div');
  heading.appendChild(el('h1', {}, 'Welcome back, Developer'));
  heading.appendChild(el('p', {}, 'Session active · bridge connected · 5 limits tracked'));
  greeting.appendChild(heading);

  const load = el('div', { class: 'load' });
  const loadRow = el('div', { class: 'row' });
  loadRow.appendChild(el('span', { class: 'caps' }, 'Daily API load'));
  loadRow.appendChild(el('span', { class: 'pct' }, '25%'));
  load.appendChild(loadRow);
  load.appendChild(meter(0.249, 'var(--sfdt-color-brand)'));
  greeting.appendChild(load);
  main.appendChild(greeting);

  const bento = el('div', { class: 'bento' });
  bento.appendChild(healthCard());
  bento.appendChild(quickActionsCard());
  main.appendChild(bento);

  main.appendChild(activityCard());

  const lower = el('div', { class: 'bento' });
  lower.style.marginTop = 'var(--sfdt-space-4)';
  lower.appendChild(limitsCard());
  lower.appendChild(el('div'));
  main.appendChild(lower);

  main.appendChild(statsRow());
  body.appendChild(main);

  const statusbar = el('div', { class: 'statusbar' });
  const connected = el('span');
  connected.appendChild(dot('var(--sfdt-color-success)'));
  connected.appendChild(document.createTextNode(`Connected: ${ORG_HOST}`));
  statusbar.appendChild(connected);
  statusbar.appendChild(el('span', {}, 'API v65.0'));
  const right = el('span', { class: 'grow' });
  right.appendChild(dot('var(--sfdt-color-success)'));
  right.appendChild(document.createTextNode('Bridge connected'));
  statusbar.appendChild(right);
  body.appendChild(statusbar);

  dash.appendChild(body);
  root.appendChild(dash);
}

// ---------------------------------------------------------------------------
// Popup comparison
// ---------------------------------------------------------------------------

function statusRow(label: string, value: string, colour: string): HTMLElement {
  const row = el('div', { class: 'status', role: 'status' });
  row.appendChild(dot(colour));
  const text = el('span');
  text.appendChild(el('strong', {}, `${label}: `));
  text.appendChild(document.createTextNode(value));
  row.appendChild(text);
  return row;
}

/** The shipping popup (lib/popup.ts + entrypoints/popup/main.ts), redrawn. */
function currentPopup(): HTMLElement {
  const popup = el('div', { class: 'popup current' });
  popup.appendChild(el('h1', {}, '⚡ SFDT for Salesforce'));

  const org = el('div', { class: 'org' });
  org.appendChild(el('strong', {}, 'Org: '));
  org.appendChild(document.createTextNode(ORG_HOST));
  popup.appendChild(org);

  popup.appendChild(statusRow('Session', 'signed in', 'var(--sfdt-color-success)'));
  popup.appendChild(statusRow('Bridge', 'connected', 'var(--sfdt-color-success)'));

  const stack = el('div', { class: 'stack' });
  stack.appendChild(el('button', { class: 'btn primary', type: 'button' }, 'Open Workspace'));
  stack.appendChild(el('button', { class: 'btn', type: 'button' }, 'Open side panel'));
  stack.appendChild(el('button', { class: 'btn', type: 'button' }, 'Open ⚡ menu on this page'));
  stack.appendChild(el('button', { class: 'btn', type: 'button' }, 'Settings'));
  popup.appendChild(stack);

  popup.appendChild(el('div', { class: 'version' }, 'v1.2.0'));
  return popup;
}

/** The Stitch nav: command list + pinned footer. Status strip kept deliberately. */
function proposedPopup(): HTMLElement {
  const popup = el('div', { class: 'popup proposed' });

  const head = el('div', { class: 'head' });
  head.appendChild(icon('bolt', 20));
  head.appendChild(el('h1', {}, 'SFDT for Salesforce'));
  popup.appendChild(head);

  // The Stitch design drops status entirely. Kept here: it is the popup's only
  // answer to "why isn't the tool working", and colour is never the sole signal.
  const strip = el('div', { class: 'strip' });
  strip.appendChild(statusRow('Org', ORG_HOST, 'var(--sfdt-color-success)'));
  strip.appendChild(statusRow('Session', 'signed in', 'var(--sfdt-color-success)'));
  strip.appendChild(statusRow('Bridge', 'not running', 'var(--sfdt-color-text-icon)'));
  popup.appendChild(strip);

  const list = el('div', { class: 'list' });

  const openWorkspace = el('button', { class: 'item accent', type: 'button' });
  openWorkspace.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('external', 20)));
  openWorkspace.appendChild(el('span', {}, 'Open Workspace'));
  list.appendChild(openWorkspace);

  const openPanel = el('button', { class: 'item', type: 'button' });
  openPanel.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('panel', 20)));
  openPanel.appendChild(el('span', {}, 'Open side panel'));
  list.appendChild(openPanel);

  list.appendChild(el('div', { class: 'sep' }));

  const allTools = el('button', { class: 'item', type: 'button' });
  allTools.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('grid', 20)));
  allTools.appendChild(el('span', {}, 'View all features'));
  list.appendChild(allTools);

  for (const id of WORKSPACE_TOOLS.slice(0, 9)) {
    if (!FEATURE_ICONS[id]) continue;
    const item = el('button', { class: 'item', type: 'button' });
    item.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, featureIcon(id, 20)));
    item.appendChild(el('span', {}, labelFor(id)));
    list.appendChild(item);
  }
  popup.appendChild(list);

  const foot = el('div', { class: 'foot' });
  foot.appendChild(el('span', { class: 'glyph', 'aria-hidden': 'true' }, icon('settings', 18)));
  foot.appendChild(el('span', {}, 'Settings'));
  foot.appendChild(el('span', { class: 'grow mono' }, 'v1.2.0'));
  popup.appendChild(foot);

  return popup;
}

function renderPopups(root: HTMLElement): void {
  const wrap = el('div', { id: 'popups' });

  const a = el('div', { class: 'col' });
  a.appendChild(el('div', { class: 'caps' }, 'Current — shipping (300px)'));
  a.appendChild(currentPopup());
  wrap.appendChild(a);

  const b = el('div', { class: 'col' });
  b.appendChild(el('div', { class: 'caps' }, 'Proposed — Stitch nav (320px)'));
  b.appendChild(proposedPopup());
  wrap.appendChild(b);

  root.appendChild(wrap);

  const notes = el('ul', { id: 'notes' });
  const points: Array<[string, string]> = [
    ['Icons', 'inline SVG (mockups/icons.ts), not the emoji in lib/feature-icons.ts and not a webfont — Material Symbols would need bundling and cannot be a Google Fonts link under MV3 CSP.'],
    ['Status rows', 'kept; the Stitch original drops them. They are the popup’s only answer to "why isn’t the tool working", and the dot is never the sole signal.'],
    ['Palette', 'flip the SLDS|Stitch toggle to A/B the Material-3 scheme against the shipping tokens. In light mode the two are nearly identical; the visible delta is dark-mode accent and surface depth.'],
  ];
  for (const [term, body] of points) {
    const li = el('li');
    li.appendChild(el('strong', {}, `${term} — `));
    li.appendChild(document.createTextNode(body));
    notes.appendChild(li);
  }
  root.appendChild(notes);
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

type Screen = 'dashboard' | 'popup';
type Theme = 'light' | 'dark' | 'auto';
type Palette = 'slds' | 'stitch';

function applyMockTheme(theme: Theme): void {
  // Same attribute lib/theme.ts writes: 'auto' means remove it and let the
  // token sheet's prefers-color-scheme block decide.
  if (theme === 'auto') document.documentElement.removeAttribute(THEME_ATTR);
  else document.documentElement.setAttribute(THEME_ATTR, theme);
}

function applyMockPalette(palette: Palette): void {
  if (palette === 'slds') document.documentElement.removeAttribute(PALETTE_ATTR);
  else document.documentElement.setAttribute(PALETTE_ATTR, palette);
}

function segmented<T extends string>(
  label: string,
  options: readonly T[],
  initial: T,
  onPick: (value: T) => void,
  labels: Partial<Record<T, string>> = {},
): HTMLElement {
  const group = el('div', { class: 'seg', role: 'group', 'aria-label': label });
  const buttons = new Map<T, HTMLButtonElement>();
  for (const option of options) {
    const text = labels[option] ?? option[0]!.toUpperCase() + option.slice(1);
    const b = el('button', { type: 'button', 'aria-pressed': String(option === initial) }, text);
    b.addEventListener('click', () => {
      for (const [key, btn] of buttons) btn.setAttribute('aria-pressed', String(key === option));
      onPick(option);
    });
    buttons.set(option, b);
    group.appendChild(b);
  }
  return group;
}

function main(): void {
  const style = document.createElement('style');
  style.textContent = `${SFDT_TOKENS_CSS}\n${SFDT_COMPONENT_CSS}\n${STITCH_PALETTE}\n${STYLES}`;
  document.head.appendChild(style);

  const root = document.getElementById('sfdt-mock-root');
  if (!root) return;

  const screen = el('div', { id: 'screen' });

  const draw = (which: Screen): void => {
    clear(screen);
    if (which === 'dashboard') renderDashboard(screen);
    else renderPopups(screen);
  };

  const bar = el('div', { id: 'mock-bar' });
  bar.appendChild(el('span', { class: 'brand' }, 'SFDT mockups'));
  bar.appendChild(segmented('Screen', ['dashboard', 'popup'] as const, 'dashboard', draw));
  bar.appendChild(el('span', { class: 'spacer' }));
  bar.appendChild(el('span', { class: 'caps' }, 'Palette'));
  bar.appendChild(
    segmented('Palette', ['slds', 'stitch'] as const, 'slds', applyMockPalette, {
      slds: 'SLDS',
      stitch: 'Stitch',
    }),
  );
  bar.appendChild(el('span', { class: 'caps' }, 'Theme'));
  bar.appendChild(segmented('Theme', ['light', 'dark', 'auto'] as const, 'light', applyMockTheme));

  root.appendChild(bar);
  root.appendChild(screen);
  draw('dashboard');
}

main();
