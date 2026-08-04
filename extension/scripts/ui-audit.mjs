#!/usr/bin/env node
// UI design-system migration audit.
//
// Prints, per source file, how much of it still builds UI by hand instead of
// through the shared layers (lib/tokens.ts → lib/ui-styles.ts → lib/icons.ts →
// lib/ui-controls.ts). Run it to answer "what is left, and where", and to check
// that a file you just migrated actually came out clean:
//
//   npm run audit:ui              full inventory, worst first
//   npm run audit:ui -- --todo    only files with work remaining
//   npm run audit:ui -- ui/       only paths matching a prefix
//
// This is a REPORT, never a gate. `npx vitest run` owns enforcement — the
// BUTTON_MIGRATED guard in test/ui-styles.test.ts and the emoji guard in
// test/icons.test.ts are what actually fail CI. This script exists because a
// hand-maintained checklist in a markdown file goes stale on the first commit
// that forgets to update it, and then "we didn't miss anything" stops being
// true without anyone noticing.
//
// The migrated lists are READ FROM THE TEST FILES rather than restated here,
// so the audit cannot disagree with the guards.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const DIRS = ['features', 'ui', 'entrypoints', 'lib'];

/** Pull a string-array literal out of a test file, e.g. `const BUTTON_MIGRATED = [...]`. */
function listFromTest(file, varName) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const start = src.indexOf(varName);
  if (start === -1) return [];
  const open = src.indexOf('[', start);
  const close = src.indexOf('];', open);
  if (open === -1 || close === -1) return [];
  return [...src.slice(open, close).matchAll(/'([^']+\.ts)'/g)].map((m) => m[1]);
}

const buttonMigrated = new Set(listFromTest('test/ui-styles.test.ts', 'BUTTON_MIGRATED'));
const emojiGuarded = new Set(listFromTest('test/icons.test.ts', 'const files = ['));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

/** Strip comments so prose about `📋` or a cssText example isn't counted as code. */
function code(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const count = (s, re) => (s.match(re) ?? []).length;

// A hand-rolled button: padding + border-radius + cursor:pointer in one string.
// Same signature the BUTTON_MIGRATED guard enforces, so a file that scores 0
// here is a file that can safely join that list.
const HAND_ROLLED_BTN =
  /padding:[^'"`]*border-radius:[^'"`]*cursor:\s*pointer|cursor:\s*pointer[^'"`]*padding:[^'"`]*border-radius:|border-radius:[^'"`]*padding:[^'"`]*cursor:\s*pointer/;
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u;

// Inline STYLING, counted separately from inline LAYOUT STATE.
//
// This column exists because the audit was gameable and got gamed. It counted
// `style.cssText` only, so migrating a file by moving the same declarations into
// discrete `el.style.padding = …` calls scored zero and reported DONE — which is
// exactly what happened to schema-browser (0 cssText, 54 discrete assignments)
// and inspect-record. The metric measured the syntax, not the behaviour.
//
// The allowlist below is the honest line: these properties carry per-instance
// VALUES that no stylesheet can know — a meter fill's width, a show/hide toggle,
// a computed position. Everything else — padding, margin, border, colour, font,
// gap, alignment — is styling, belongs in lib/ui-styles.ts, and is counted.
const DYNAMIC_STYLE_PROPS = new Set([
  'display',
  'width',
  'height',
  'left',
  'top',
  'right',
  'bottom',
  'transform',
  'opacity',
  'zIndex',
  'visibility',
  'maxHeight',
  'scrollTop',
  // SVG paint. A `var(--sfdt-*)` does not resolve in a presentation attribute,
  // so setting the CSS property is the ONLY way an SVG shape can be themed —
  // and the value is per-node. This is a real exception, not an escape hatch.
  'fill',
  'stroke',
]);
const STYLE_PROP_ASSIGN = /\.style\.([a-zA-Z]+)\s*=/g;

// Reviewed exceptions — a NAMED list, not a widened allowlist, so each one is a
// decision someone made rather than a hole a whole property class fell through.
// Both surviving entries have the same shape: they read an element's CURRENT
// value and only set it if absent, on DOM this extension does not own. A class
// always sets, so it would clobber the host page's own layout.
const EXEMPT_INLINE = [
  {
    file: 'features/canvas-search.ts',
    match: /canvasHost\.style\.position = canvasHost\.style\.position \|\|/,
    because: "Salesforce's Flow canvas element; only positions it if the page has not already.",
  },
  {
    file: 'ui/workspace-tabs.ts',
    match: /if \(!view\.body\.style\.flex\) view\.body\.style\.flex/,
    because: 'respects a flex value the mounted feature set for itself.',
  },
];

// These define the system rather than consume it; they contain CSS text by
// nature and would otherwise report as permanently un-migrated.
const SYSTEM_FILES = new Set(['lib/tokens.ts', 'lib/ui-styles.ts', 'lib/icons.ts', 'lib/ui-controls.ts']);

const rows = [];
for (const dir of DIRS) {
  for (const file of walk(dir)) {
    if (SYSTEM_FILES.has(file)) continue;
    const src = code(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (!/createElement|cssText|sfdt-/.test(src)) continue; // not a UI file

    const emojiLines = src.split('\n').filter((l) => EMOJI.test(l));
    const btnRaw = count(src, /createElement\('button'\)/g);
    const inputRaw = count(src, /createElement\('input'\)/g);
    const cssText = count(src, /\.style\.cssText/g);

    // Discrete `el.style.foo = …` assignments whose property is NOT in the
    // dynamic allowlist. Reported as `inl`.
    let inlineStyle = 0;
    const exemptions = EXEMPT_INLINE.filter((e) => e.file === file);
    for (const line of src.split('\n')) {
      if (exemptions.some((e) => e.match.test(line))) continue;
      for (const m of line.matchAll(STYLE_PROP_ASSIGN)) {
        const prop = m[1];
        if (prop === 'cssText' || DYNAMIC_STYLE_PROPS.has(prop)) continue;
        inlineStyle += 1;
      }
    }

    // Split by WHERE the button CSS lives, because the fix differs: an inline
    // cssText site becomes a button() call, while a rule inside a page-local
    // stylesheet template becomes a class on the element instead.
    let inlineBtn = 0;
    let sheetBtn = 0;
    for (const line of src.split('\n')) {
      if (!HAND_ROLLED_BTN.test(line)) continue;
      if (/\.style\.cssText|cssText\s*=|CSS\s*=|'.*cursor: pointer.*'/.test(line) && !/^\s*#|^\s*\./.test(line.trim())) inlineBtn += 1;
      else sheetBtn += 1;
    }

    rows.push({
      file,
      btnRaw,
      btnNew: count(src, /\bbutton\(\{/g),
      handRolled: inlineBtn + sheetBtn,
      inlineBtn,
      sheetBtn,
      inputRaw,
      inputNew: count(src, /\bfield\(\{/g),
      cssText,
      inlineStyle,
      emoji: emojiLines.length,
      emojiSample: emojiLines[0]?.trim().slice(0, 60) ?? '',
      // Does this file build any UI at all? A router or a message handler that
      // merely mentions `sfdt-` has nothing to migrate and should not sit on a
      // to-do list forever.
      buildsUi: btnRaw + inputRaw + cssText + inlineStyle > 0 || /createElement\(/.test(src),
      guardedBtn: buttonMigrated.has(file),
      guardedEmoji: emojiGuarded.has(file),
    });
  }
}

// "Work remaining" is what the guards would reject today: a hand-rolled button
// signature, an emoji in code, or inline styling that a component class should
// own. cssText is reported but NOT counted as todo on its own — a `cssText`
// holding only dynamic properties is fine, and the `inl` column is the honest
// measure of the same thing at a finer grain.
const todo = (r) => r.handRolled + r.emoji + r.inlineStyle;
const done = (r) => todo(r) === 0 && (r.guardedBtn || !r.buildsUi) && (r.guardedEmoji || !r.buildsUi);

const args = process.argv.slice(2);
const onlyTodo = args.includes('--todo');
const prefix = args.find((a) => !a.startsWith('--'));

let list = rows;
if (prefix) list = list.filter((r) => r.file.startsWith(prefix));
if (onlyTodo) list = list.filter((r) => !done(r));
list.sort((a, b) => todo(b) - todo(a) || b.cssText - a.cssText || a.file.localeCompare(b.file));

const pad = (s, n) => String(s).padEnd(n);
const num = (n, n2 = 4) => String(n === 0 ? '·' : n).padStart(n2);

console.log('');
console.log(`UI migration audit — ${rows.length} UI files scanned`);
console.log('');
console.log(`${pad('file', 38)} ${num('btn')} ${num('new')} ${num('HAND')} ${num('inp')} ${num('css')} ${num('inl')} ${num('emo')} status`);
console.log('-'.repeat(92));
for (const r of list) {
  const status = !r.buildsUi
    ? 'n/a — builds no UI'
    : done(r)
      ? 'DONE'
      : todo(r) === 0
        ? 'clean — add to guard lists'
        : [
            r.inlineBtn ? `${r.inlineBtn} inline btn` : '',
            r.sheetBtn ? `${r.sheetBtn} sheet btn` : '',
            r.emoji ? `${r.emoji} emoji` : '',
            r.inlineStyle ? `${r.inlineStyle} inline style` : '',
          ]
            .filter(Boolean)
            .join(', ');
  console.log(
    `${pad(r.file, 38)} ${num(r.btnRaw)} ${num(r.btnNew)} ${num(r.handRolled)} ${num(r.inputRaw)} ${num(r.cssText)} ${num(r.inlineStyle)} ${num(r.emoji)} ${status}`,
  );
}

const remaining = rows.filter((r) => !done(r));
console.log('-'.repeat(92));
console.log(
  `${rows.length - remaining.length} done · ${remaining.length} remaining · ` +
    `${rows.reduce((s, r) => s + r.handRolled, 0)} hand-rolled buttons · ` +
    `${rows.reduce((s, r) => s + r.emoji, 0)} emoji lines · ` +
    `${rows.reduce((s, r) => s + r.inlineStyle, 0)} inline styles · ` +
    `${rows.reduce((s, r) => s + r.cssText, 0)} cssText sites`,
);
console.log('');
console.log('btn=createElement(button)  new=button({})  HAND=hand-rolled button CSS');
console.log('inp=createElement(input)  css=style.cssText  emo=emoji in code');
console.log('inl=el.style.<prop>= for a NON-dynamic property (padding, colour, border, …)');
console.log('A file is DONE when HAND, inl and emo are 0 AND it is on both guard lists.');
console.log('');
