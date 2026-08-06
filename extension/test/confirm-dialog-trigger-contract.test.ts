// A caller must not disable the control that opens the confirm dialog.
//
// `ui/confirm-dialog.ts` restores focus to whatever was focused when it opened
// — normally the button that opened it. `.focus()` on a **disabled** element is
// a no-op by specification, so a caller that does
//
//     btn.disabled = true;
//     await confirmDialog({ … });
//
// strands the keyboard user on `<body>` after cancelling a destructive dialog,
// and nothing inside the dialog can fix it. That is #326's B1, found by review
// on the bulk-delete surface and fixed at the call site with an `onConfirmed`
// hook that disables the trigger only once the destructive phase begins.
//
// ── Why this file exists at all ─────────────────────────────────────────────
//
// #326's PR body claimed the shared layer got tests "so the next caller hits a
// red test". It did not. `test/confirm-dialog.test.ts` pins the DIALOG's
// behaviour — that it restores focus to an enabled trigger, and that it cannot
// restore focus to a disabled one. Neither assertion can detect a violating
// CALLER: `features/debug-log-viewer.ts` had exactly the banned shape while the
// whole suite was green, which is the proof. A doc comment plus two tests about
// the callee is documentation, not a guard.
//
// What delivers the claim is this: a sweep over the source, in the shape of
// `test/sf-error-panel-contract.test.ts`, that reads the code PATH.
//
// ── The rule, and the three things it is careful about ──────────────────────
//
// Flag a `.disabled = true` that lexically PRECEDES a `confirmDialog(…)` call
// reached from the same function body.
//
// **Ordering** is the first, because the correct fix writes the same two tokens
// in the other order:
//
//     const ok = await confirmDialog({ … });
//     if (!ok) return;
//     btn.disabled = true;            // the destructive phase — correct
//
// A rule that ignored position would flag that, and a guard that flags the fix
// it is asking for teaches people to route around it.
//
// **Nesting direction** is the second. `features/soql-runner.ts` hands
// `runBulkDelete` two SIBLING callbacks — `confirm:` opens the dialog,
// `onConfirmed:` disables the trigger — and neither encloses the other, so the
// fixed shape is clean whichever order the object literal happens to list them
// in. But a disable in the ENCLOSING body, with the dialog call down in a
// callback, is the B1 defect exactly:
//
//     async function start(btn) {
//       btn.disabled = true;                                    // ← flagged
//       await runBulkDelete(rows, { confirm: () => confirmDialog({ … }) });
//     }
//
// so an enclosing function counts and a sibling does not. The round-2 review's
// "B1 regressed" mutation is that shape; this sweep catches it independently of
// the behavioural test that also does.
//
// **`await` is the third**, and it is what keeps the enclosing case honest. A
// function expression handed to another call MIGHT be invoked during that call
// or might be stored for later, and nothing lexical can tell those apart from
// the callee's name — which is exactly the kind of guessing that has holed the
// sibling guard three times. Measured before this rule had the condition, the
// enclosing case reported `features/flow-version-manager.ts:187`, where
//
//     btn.disabled = true;                       // a freshly created button's
//     btn.addEventListener('click', () => void handleBulkDelete());
//
// sets the INITIAL state of a toolbar button that `updateToolbar()` re-enables
// the moment a row is selected. The trigger is enabled when the user can click
// it, the click handler runs in a different turn, and flagging it would mean
// editing correct code to satisfy a check.
//
// So the enclosing case additionally requires the body to **`await` something
// after the disable**:
//
//     scan.awaits.some((a) => a.inFn === from && a.start > disable.at)
//
// The condition is about CONTROL FLOW — this body disabled a control and then
// suspended on something, so a callback it handed out may well have run in
// between — and the first version of it was not. It asked whether the dialog
// call sat lexically INSIDE the await expression's text range, which is a
// FORMATTING fact wearing a control-flow fact's clothes, and the review of #332
// found the hole that opens: hoisting the callback to a `const` on the line
// above is a behaviour-preserving refactor that moves the text out of the range
// while the callback still runs during the await.
//
//     btn.disabled = true;
//     const deps = { confirm: (p, phrase) => confirmDialog({ … }) };  // ← moved
//     await runBulkDelete(rows, deps);
//
// Both forms are the B1 regression on the real `soql-runner.ts`; the text-range
// rule caught the inline one and went GREEN on the hoisted one, so on the next
// surface — which by construction has no focus test yet — nothing would have
// caught it. `detects the B1 shape` now pins both, and the narrower condition
// declines `flow-version-manager.ts:187` for the reason that actually applies:
// `ensureToolbarButton()` awaits nothing at all.
//
// What it over-approximates, named rather than discovered later: a body that
// disables a control, awaits something unrelated, and only THEN registers a
// listener would be flagged. That fires in the safe direction — it produces a
// site to look at, not a rule that goes quiet — and there is no such site in
// the tree. `void doIt(cb)` in a body with no `await` at all remains open, and
// is asserted as open below.
//
// ── Why it asks the compiler, and why it still masks ────────────────────────
//
// All three questions above are about SCOPE, and scope is the thing a regex
// cannot answer. Hand-rolling brace matching to find function bodies is the
// move this repo has now watched fail three times in the sibling guard — rounds
// 3, 4 and 6 each shipped a fix that opened a new hole, twice inside the
// machinery the fix itself added, and every one was a pattern that had to
// guess. `ts.createSourceFile()` does not guess: a `{` inside a string is a
// string, a `.disabled` inside a comment is not an assignment, and a function
// body is exactly the span the grammar says it is.
//
// The mask is still load-bearing, for the one thing the AST alone does not
// give: a fail-closed answer. `dynamicParts()` from `./error-source-scan.ts`
// refuses, loudly, on an unterminated literal or block comment — the shape that
// makes a scanner blank a region and go silently green over it. It is called
// here for that refusal, and its output is cross-checked against the AST's
// findings on every scanned file (`the AST and the mask agree about where the
// disables are`), so the two mechanisms have to fail together or not at all.
// That masker is parser-based and has survived two adversarial reviews; it is
// reused, not re-derived.
//
// ── Golden principle #12 ────────────────────────────────────────────────────
//
// There are **no exclusions**, and that is a result rather than an omission.
// `ui/confirm-dialog.ts` writes the banned shape verbatim in its own caller
// contract — `btn.disabled = true;` on one line, `await confirmDialog({ … });`
// on the next — inside a doc comment, and it is the file this whole rule is
// about. Through the AST that comment is not code and through the mask it is
// blanked prose, so the one file that would otherwise need an exemption needs
// none. `the dialog's own caller contract is prose, not a violation` pins that
// against the real file, and `there is nothing to exempt` pins the empty list,
// so an entry cannot be added later without a reason that survives the
// would-it-actually-fail bite-check the sibling guard applies. `test/` is not
// scanned, for the same reason it is not scanned there: a test that writes the
// shape in order to assert on it is describing the contract.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ts from 'typescript';
import { dynamicParts } from './error-source-scan.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** Every directory that ships DOM-building code — the sibling guard's set. */
const SCANNED_DIRS = ['features', 'ui', 'entrypoints', 'lib'];

/** The shared dialog. Local wrappers around it are discovered per file. */
const DIALOG = 'confirmDialog';

/**
 * The artifacts that DEFINE the rule and therefore cannot violate it.
 *
 * Empty, and it stays empty until an entry can pass the bite-check in `every
 * exclusion would actually fail without it` — the property the sibling guard
 * learned the hard way: an exclusion for a file that trips nothing is not an
 * exclusion, it is a permanent hole bought for nothing.
 */
const DEFINING_ARTIFACTS: { file: string; because: string }[] = [];

// ── The compiler's answer to "which function is this in?" ───────────────────

interface Span {
  readonly start: number;
  readonly end: number;
  /**
   * The name a LOCAL CALLER would use, or null.
   *
   * Deliberately not the property name of an object-literal callback: `confirm:
   * (plan, phrase) => confirmDialog({ … })` is handed to someone else and is
   * never invoked as `confirm(…)` in this file, so treating it as a wrapper
   * would claim the bare word `confirm` for the whole file.
   */
  readonly callableAs: string | null;
}

interface Scan {
  readonly root: Span;
  readonly functions: Span[];
  /** `X.disabled = true`, with the receiver's source text. */
  readonly disables: { at: number; receiver: string }[];
  /** Every `f(…)` whose callee is a plain identifier. */
  readonly calls: { at: number; name: string }[];
  /** Every `await …`, and the body it is evaluated in. */
  readonly awaits: { start: number; end: number; inFn: Span }[];
}

const PARSED = new Map<string, Scan>();
let parsedChars = 0;
/** Bounded in BYTES, for the reason `MaskCache` is: whole files are large. */
const CACHE_BUDGET_CHARS = 4 * 1024 * 1024;

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function callableAs(node: ts.Node): string | null {
  if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) return node.name.text;
  const parent = node.parent as ts.Node | undefined;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/** The smallest function body containing `at` — the file itself if none does. */
function innermost(scan: Scan, at: number): Span {
  let best = scan.root;
  for (const s of scan.functions) {
    if (s.start <= at && at < s.end && s.end - s.start < best.end - best.start) best = s;
  }
  return best;
}

const encloses = (outer: Span, inner: Span): boolean =>
  outer.start <= inner.start && inner.end <= outer.end;

const isStringLiteral = (node: ts.Node | undefined, text: string): boolean =>
  node !== undefined && ts.isStringLiteralLike(node) && node.text === text;

/**
 * The receiver of a `… = true` assignment that disables a control, or null.
 *
 * Two spellings: `btn.disabled` and `btn['disabled']`. The review of #332 named
 * the second (and `setAttribute('disabled', …)`, handled at the call site) as
 * declined and unnamed. Both are caught rather than named, because both are
 * exact AST shapes and neither costs anything: measured over the 125 scanned
 * files, there are **zero** occurrences of either, so the false-positive cost
 * is nil and the assertion below keeps that measurement honest.
 *
 * Still out, and named here: `btn.disabled = busy`. That is a state sync —
 * `flow-version-manager.ts` writes `toolbarBtn.disabled = count === 0` on every
 * toolbar repaint and it has nothing to do with a dialog — and claiming it
 * would flag correct code all over the tree.
 */
function disabledTarget(left: ts.Expression): string | null {
  if (ts.isPropertyAccessExpression(left) && left.name.text === 'disabled') {
    return left.getText();
  }
  if (ts.isElementAccessExpression(left) && isStringLiteral(left.argumentExpression, 'disabled')) {
    return left.getText();
  }
  return null;
}

/**
 * Read the file once, through the compiler.
 *
 * `dynamicParts()` runs first and is not optional: it is the fail-closed gate.
 * On an unterminated literal or block comment it throws rather than handing
 * back a blanked buffer, and a blanked buffer is one every rule reads as
 * containing no code at all — the silent-green failure this codebase has now
 * shipped three times in the sibling guard.
 */
export function scanSource(source: string): Scan {
  const cached = PARSED.get(source);
  if (cached !== undefined) return cached;
  dynamicParts(source);
  const file = ts.createSourceFile(
    'scan.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const root: Span = { start: 0, end: source.length, callableAs: null };
  const scan: Scan = { root, functions: [], disables: [], calls: [], awaits: [] };
  const pendingAwaits: { start: number; end: number }[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      scan.functions.push({
        start: node.getStart(file),
        end: node.end,
        callableAs: callableAs(node),
      });
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      node.right.kind === ts.SyntaxKind.TrueKeyword &&
      disabledTarget(node.left) !== null
    ) {
      scan.disables.push({ at: node.getStart(file), receiver: disabledTarget(node.left)! });
    } else if (
      // `el.setAttribute('disabled', …)` — the third way to disable a control,
      // and the value is irrelevant: any value of the attribute disables it.
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'setAttribute' &&
      isStringLiteral(node.arguments[0], 'disabled')
    ) {
      scan.disables.push({
        at: node.getStart(file),
        receiver: node.expression.expression.getText(file),
      });
    } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      scan.calls.push({ at: node.getStart(file), name: node.expression.text });
    } else if (ts.isAwaitExpression(node)) {
      pendingAwaits.push({ start: node.getStart(file), end: node.end });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(file, visit);
  // Function spans have to be complete before an await can be attributed to a
  // body, so this is a second pass rather than part of the walk.
  for (const a of pendingAwaits) scan.awaits.push({ ...a, inFn: innermost(scan, a.start) });
  if (parsedChars + source.length > CACHE_BUDGET_CHARS) {
    PARSED.clear();
    parsedChars = 0;
  }
  PARSED.set(source, scan);
  parsedChars += source.length;
  return scan;
}

/**
 * `confirmDialog`, plus the local functions that forward to it.
 *
 * `features/flow-version-manager.ts` reaches the dialog through a one-line
 * `confirmModal(doc, selected)` whose whole job is to describe what is being
 * deleted. A rule keyed on the literal word `confirmDialog` would watch the
 * wrapper's body and not the caller that invokes it — which is where a disable
 * would go. Taken to a fixed point, so a second hop is covered too.
 *
 * It over-includes rather than under-includes: a function that merely CONTAINS
 * a dialog call is treated as one, which produces a site to look at rather than
 * a rule that goes quiet. The declaration `export function confirmDialog(…)` is
 * not a call and never reaches here — the scan reads CallExpressions only, so
 * the module that defines the dialog does not name itself a caller of it.
 */
export function dialogFunctionNames(source: string): Set<string> {
  const scan = scanSource(source);
  const names = new Set<string>([DIALOG]);
  for (let pass = 0; pass < 5; pass++) {
    const before = names.size;
    for (const call of scan.calls) {
      if (!names.has(call.name)) continue;
      const fn = innermost(scan, call.at);
      if (fn.callableAs) names.add(fn.callableAs);
    }
    if (names.size === before) break;
  }
  return names;
}

/** Where the dialog is opened, directly or through a local wrapper. */
export function dialogCallSites(source: string): { at: number; name: string }[] {
  const names = dialogFunctionNames(source);
  return scanSource(source).calls.filter((c) => names.has(c.name));
}

/** The rule: a trigger disabled on the way IN to the dialog. */
export function disablesTriggerBeforeDialog(source: string): string[] {
  const scan = scanSource(source);
  const calls = dialogCallSites(source);
  if (calls.length === 0) return [];
  const out: string[] = [];
  for (const disable of scan.disables) {
    const from = innermost(scan, disable.at);
    const hit = calls.find((call) => {
      if (disable.at >= call.at) return false;
      const opened = innermost(scan, call.at);
      if (from === opened) return true;
      if (!encloses(from, opened)) return false;
      // The enclosing case, and only when this body suspends after the disable
      // — a control-flow fact, deliberately NOT "the call sits inside the await
      // expression's text", which a `const` hoist walks straight out of. See
      // the header.
      return scan.awaits.some((a) => a.inFn === from && a.start > disable.at);
    });
    if (!hit) continue;
    const line = source.slice(0, disable.at).split('\n').length;
    out.push(`${disable.receiver} = true (line ${line}) before ${hit.name}(`);
  }
  return out;
}

// ── The scan ────────────────────────────────────────────────────────────────

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const name of readdirSync(abs)) {
      const full = path.join(abs, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full);
    }
  };
  for (const dir of SCANNED_DIRS) walk(path.join(ROOT, dir));
  return out;
}

const isDefining = (rel: string): boolean => DEFINING_ARTIFACTS.some((a) => a.file === rel);

function scannedSources(): { rel: string; source: string }[] {
  return sourceFiles()
    .map((abs) => path.relative(ROOT, abs))
    .filter((rel) => !isDefining(rel))
    .map((rel) => ({ rel, source: readFileSync(path.join(ROOT, rel), 'utf8') }));
}

const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf8');

describe('nothing disables the control that opens the confirm dialog', () => {
  it('no caller disables its trigger on the way into the dialog', () => {
    const offenders = scannedSources().flatMap(({ rel, source }) =>
      disablesTriggerBeforeDialog(source).map((v) => `${rel}: ${v}`),
    );

    expect(
      offenders,
      'these disable a control before opening the confirm dialog, so the dialog cannot ' +
        `restore focus to it and a cancelled destructive action strands the user on <body>:\n${offenders.join(
          '\n',
        )}\n\n` +
        'Disable AFTER the dialog resolves — or hand the destructive runner an onConfirmed ' +
        'hook and disable there, which is what features/soql-runner.ts does. Guarding ' +
        're-entrancy with `disabled` while a MODAL dialog is up is redundant anyway: it ' +
        'mounts a full-viewport scrim over the trigger and traps Tab inside itself.',
    ).toEqual([]);
  });

  it('scans the files it claims to', () => {
    // A file-scan assertion that silently matched nothing stays green forever.
    const scanned = new Set(sourceFiles().map((abs) => path.relative(ROOT, abs)));
    for (const rel of [
      'features/debug-log-viewer.ts',
      'features/flow-version-manager.ts',
      'features/soql-runner.ts',
      'ui/confirm-dialog.ts',
    ]) {
      expect(scanned.has(rel), `${rel} must be in the scan`).toBe(true);
    }
    expect(scanned.size).toBeGreaterThan(60);
  });

  it('finds every caller of the dialog, and only those', () => {
    // The other half of "scans the files it claims to": a rule that watches the
    // wrong functions is decoration. These three are the whole caller set —
    // `git grep confirmDialog` over features/ui/entrypoints/lib.
    const callers = scannedSources()
      .filter(({ source }) => dialogCallSites(source).length > 0)
      .map(({ rel }) => rel)
      .sort();
    expect(callers).toEqual([
      'features/debug-log-viewer.ts',
      'features/flow-version-manager.ts',
      'features/soql-runner.ts',
    ]);
    // …and the wrapper hop is live in the tree, not only in a fixture: the
    // flow version manager never writes `confirmDialog(` at a call site.
    expect(dialogFunctionNames(read('features/flow-version-manager.ts'))).toContain('confirmModal');
    expect(read('features/flow-version-manager.ts')).not.toMatch(
      /=\s*confirmDialog\(|await confirmDialog\(/,
    );
  });

  it('detects the canonical violation', () => {
    const bad = [
      'async function onClick() {',
      '  btn.disabled = true;',
      '  const ok = await confirmDialog({ doc, title: t, message: m, confirmLabel: l });',
      '  if (ok) await destroy();',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(bad)).toHaveLength(1);
    expect(disablesTriggerBeforeDialog(bad)[0]).toContain('btn.disabled = true (line 2)');
  });

  it('detects the B1 shape — disabled in the body, dialog down in a callback', () => {
    // The round-2 review's regression mutation, as a source shape. The
    // behavioural test in test/soql-runner-bulk-delete.test.ts catches it on
    // that one surface; this catches it on every surface, including the next
    // one nobody has written a focus test for.
    //
    // BOTH forms, because the review of #332 regressed B1 on the real
    // soql-runner.ts twice and the first version of this rule only caught the
    // first. Hoisting the deps object to a `const` is a behaviour-preserving
    // refactor — the callback still runs during the await — and it walked out
    // of a condition that asked where the call sat in the await's TEXT. On the
    // next surface, with no focus test, nothing would have been left.
    const inline = [
      'async function start(btn) {',
      '  btn.disabled = true;',
      '  await runBulkDelete(rows, {',
      '    confirm: (plan, phrase) => confirmDialog({ doc, requireTyped: phrase }),',
      '  });',
      '}',
    ].join('\n');
    const hoisted = [
      'async function start(btn) {',
      '  btn.disabled = true;',
      '  const deps = {',
      '    confirm: (plan, phrase) => confirmDialog({ doc, requireTyped: phrase }),',
      '  };',
      '  await runBulkDelete(rows, deps);',
      '}',
    ].join('\n');
    const hoistedCallback = [
      'async function start(btn) {',
      '  btn.disabled = true;',
      '  const ask = (plan, phrase) => confirmDialog({ doc, requireTyped: phrase });',
      '  await runBulkDelete(rows, { confirm: ask });',
      '}',
    ].join('\n');
    for (const [label, src] of [
      ['callback inline', inline],
      ['deps object hoisted to a const', hoisted],
      ['the callback itself hoisted to a const', hoistedCallback],
    ] as const) {
      expect(disablesTriggerBeforeDialog(src), label).toHaveLength(1);
    }
  });

  it('declines the correct order — disabled AFTER the dialog answers', () => {
    // The fix the rule is asking for. A guard that flagged this would push the
    // next author into a helper function for no reason.
    const good = [
      'async function onClick() {',
      '  const ok = await confirmDialog({ doc, title: t, message: m, confirmLabel: l });',
      '  if (!ok) return;',
      '  btn.disabled = true;',
      '  try { await destroy(); } finally { btn.disabled = false; }',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(good)).toEqual([]);
  });

  it('declines sibling callbacks, in either order', () => {
    // features/soql-runner.ts's shape. `confirm:` and `onConfirmed:` are two
    // callbacks of one call; neither encloses the other, and an object literal
    // has no meaningful order — so a rule that read position alone would flag
    // one arrangement of the CORRECT code and not the other.
    const confirmFirst = [
      'async function start(btn) {',
      '  await runBulkDelete(rows, {',
      '    confirm: (plan, phrase) => confirmDialog({ doc, requireTyped: phrase }),',
      '    onConfirmed: () => { btn.disabled = true; },',
      '  });',
      '}',
    ].join('\n');
    const onConfirmedFirst = [
      'async function start(btn) {',
      '  await runBulkDelete(rows, {',
      '    onConfirmed: () => { btn.disabled = true; },',
      '    confirm: (plan, phrase) => confirmDialog({ doc, requireTyped: phrase }),',
      '  });',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(confirmFirst)).toEqual([]);
    expect(disablesTriggerBeforeDialog(onConfirmedFirst)).toEqual([]);
  });

  it('declines a listener registered in the same body', () => {
    // features/flow-version-manager.ts:187 verbatim in shape — the initial
    // state of a freshly created toolbar button, next to the click handler that
    // will one day open the dialog in a different turn. Measured: this was the
    // enclosing case's one tree-wide false positive before the `await`
    // condition, and it is why that condition exists.
    const good = [
      'function ensureToolbarButton() {',
      '  const btn = doc.createElement("input");',
      '  btn.disabled = true;',
      '  btn.addEventListener("click", () => void handleBulkDelete());',
      '}',
      'async function handleBulkDelete() {',
      '  const ok = await confirmModal(doc, items);',
      '}',
      'async function confirmModal(d, items) {',
      '  return confirmDialog({ doc: d, requireTyped: "DELETE" });',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(good)).toEqual([]);
    // …and the real file agrees.
    expect(disablesTriggerBeforeDialog(read('features/flow-version-manager.ts'))).toEqual([]);

    // The same thing in an ASYNC body, which is why the await condition is
    // "awaits something AFTER the disable" and not merely "awaits something".
    // A render function that fetches, then paints a toolbar, has an `await` in
    // it — but it happened before the disable, so no callback can have run
    // between the two. Dropping the `> disable.at` half survived every other
    // assertion in this file, which is exactly the kind of silent widening
    // this guard exists to refuse.
    const asyncRender = [
      'async function render() {',
      '  await loadRows();',
      '  btn.disabled = true;',
      '  btn.addEventListener("click", () => void handleBulkDelete());',
      '}',
      'async function handleBulkDelete() {',
      '  await confirmDialog({ doc });',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(asyncRender)).toEqual([]);
    // …and the same body with the await moved AFTER the disable is caught, so
    // the decline above is about ordering and not about the shape at large.
    const asyncRenderAwaitAfter = [
      'async function render() {',
      '  btn.disabled = true;',
      '  await loadRows();',
      '  btn.addEventListener("click", () => void handleBulkDelete());',
      '}',
      'async function handleBulkDelete() {',
      '  await confirmDialog({ doc });',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(asyncRenderAwaitAfter)).toHaveLength(1);
  });

  it('follows a local wrapper around the dialog', () => {
    // Without the fixed point the rule would watch `confirmModal`'s body — one
    // line that builds a message — and never look at the caller, which is where
    // a disable goes. Both hops.
    const oneHop = [
      'async function onClick() {',
      '  btn.disabled = true;',
      '  const ok = await confirmModal(doc, items);',
      '}',
      'async function confirmModal(d, items) {',
      '  return confirmDialog({ doc: d, requireTyped: "DELETE" });',
      '}',
    ].join('\n');
    const twoHops = [
      'async function onClick() {',
      '  btn.disabled = true;',
      '  const ok = await askFirst();',
      '}',
      'async function askFirst() {',
      '  return confirmModal(doc, items);',
      '}',
      'async function confirmModal(d, items) {',
      '  return confirmDialog({ doc: d, requireTyped: "DELETE" });',
      '}',
    ].join('\n');
    expect(disablesTriggerBeforeDialog(oneHop)).toHaveLength(1);
    expect(disablesTriggerBeforeDialog(twoHops)).toHaveLength(1);
  });

  it("the dialog's own caller contract is prose, not a violation", () => {
    // ui/confirm-dialog.ts documents the banned shape verbatim:
    //
    //     btn.disabled = true;
    //     await confirmDialog({ … });   // restore lands on <body>
    //
    // in a doc comment, and it also writes `confirmBtn.disabled = true` for its
    // own typed gate. Read as raw text it is the loudest offender in the tree;
    // read as code it is nothing. This is the file the mask and the AST are
    // BOTH here for, and it is why the exclusion list is empty.
    const source = read('ui/confirm-dialog.ts');
    expect(source).toMatch(/btn\.disabled = true;\n \* {5}await confirmDialog\(/);
    expect(disablesTriggerBeforeDialog(source)).toEqual([]);
    // The same shape in a comment, in a string, and in a template literal —
    // none of them is code.
    const inComment = '// btn.disabled = true;\n// await confirmDialog({ doc });';
    const inBlock = '/*\nbtn.disabled = true;\nawait confirmDialog({ doc });\n*/';
    const inString = "const doc1 = 'btn.disabled = true; await confirmDialog({});';";
    const inTemplate = 'const doc2 = `btn.disabled = true;\nawait confirmDialog({});`;';
    for (const [label, src] of [
      ['line comment', inComment],
      ['block comment', inBlock],
      ['string literal', inString],
      ['template literal', inTemplate],
    ] as const) {
      expect(disablesTriggerBeforeDialog(src), label).toEqual([]);
    }
  });

  it('a stray backtick in a comment cannot blind the rule', () => {
    // #327's B1, applied to this guard. The masker it inherits is parser-based
    // and cannot be opened by an unbalanced backtick; the AST cannot be either.
    // Each case is the real defect with one blinder above it.
    const defect = [
      'async function onClick() {',
      '  btn.disabled = true;',
      '  const ok = await confirmDialog({ doc });',
      '}',
    ].join('\n');
    const blinders: [string, string][] = [
      ['one backtick in a line comment', '// The org returns a ` fenced block.'],
      ['three backticks in a line comment', '// Wrap the reply in ```json first.'],
      ['a backtick in a block comment', '/* The org sometimes sends a ` here. */'],
      ['a backtick in a regex character class', "const clean = raw.replace(/[`]/g, '');"],
      [
        'a backtick in a comment, the defect 40 lines later',
        `// The org returns a \` fenced block.\n${'const spacer = 1;\n'.repeat(40)}`,
      ],
    ];
    for (const [label, blinder] of blinders) {
      expect(disablesTriggerBeforeDialog(`${blinder}\n${defect}`), label).toHaveLength(1);
    }
    // The control: if this ever fails, the cases above pass for the wrong reason.
    expect(disablesTriggerBeforeDialog(defect)).toHaveLength(1);
  });

  it('refuses to answer on source no scanner can read', () => {
    // Fail closed, inherited from `dynamicParts()`. An unterminated literal or
    // block comment blanks everything after it, and a blanked buffer is one
    // this rule would read as containing no code — a silent green over an
    // arbitrary span, which is the exact failure shape the sibling guard has
    // shipped three times.
    for (const src of [
      '/* never closed\nbtn.disabled = true;\nawait confirmDialog({ doc });',
      "const s = 'never closed;\nbtn.disabled = true;\nawait confirmDialog({ doc });",
    ]) {
      expect(() => disablesTriggerBeforeDialog(src)).toThrow(/refusing to mask/);
    }
    // …and a LINE CONTINUATION, which is legal source a contributor could write
    // tomorrow, must not be mistaken for one. Round 6 shipped that regression
    // in the masker; this guard must not re-import it.
    const continued = "const banner = 'Could not reach the org — \\\n  try again.';\n";
    const defect = 'async function f() {\n  b.disabled = true;\n  await confirmDialog({ doc });\n}';
    expect(() => disablesTriggerBeforeDialog(continued)).not.toThrow();
    expect(disablesTriggerBeforeDialog(continued + defect)).toHaveLength(1);
  });

  it('the AST and the mask agree about where the disables are', () => {
    // Two independent mechanisms over the same question, tree-wide. The AST
    // finds a disable as a node; the masker finds it as text with every comment
    // and string interior blanked. They can only disagree if one of them has
    // started missing things — which is the failure this codebase cannot see
    // any other way, because it fails GREEN.
    //
    // All three spellings the scan knows, so widening it cannot quietly narrow
    // the agreement: the counterpart of each is counted on the masked buffer.
    const TEXTUAL = [
      /\.\s*disabled\s*=\s*true\b/g,
      /\[\s*['"]disabled['"]\s*\]\s*=\s*true\b/g,
      /\.\s*setAttribute\s*\(\s*['"]disabled['"]/g,
    ];
    const disagreements: string[] = [];
    for (const { rel, source } of scannedSources()) {
      const viaAst = scanSource(source).disables.length;
      const masked = dynamicParts(source);
      const viaMask = TEXTUAL.reduce((n, re) => n + [...masked.matchAll(re)].length, 0);
      if (viaAst !== viaMask) disagreements.push(`${rel}: ast=${viaAst} mask=${viaMask}`);
    }
    expect(disagreements).toEqual([]);
    // And the count is not zero, or the agreement is vacuous.
    const total = scannedSources().reduce((n, f) => n + scanSource(f.source).disables.length, 0);
    expect(total).toBeGreaterThan(30);
  });

  it('the two rarer disable spellings cost nothing, and that is measured', () => {
    // `el['disabled'] = true` and `el.setAttribute('disabled', …)` were flagged
    // by review as declined and unnamed. They are caught instead of named,
    // which is only defensible because the false-positive cost is measurably
    // nil: there is no occurrence of either in the tree, so widening the scan
    // moved no verdict. If one appears later this assertion is the prompt to
    // re-measure rather than to assume.
    const rarer = [
      /\[\s*['"]disabled['"]\s*\]\s*=\s*true\b/g,
      /setAttribute\s*\(\s*['"]disabled['"]/g,
    ];
    const found = scannedSources().flatMap(({ rel, source }) => {
      const masked = dynamicParts(source);
      return rarer.flatMap((re) => [...masked.matchAll(re)].map(() => rel));
    });
    expect(found).toEqual([]);
    // …and they ARE caught, so the zero above is a measurement and not a
    // second way of saying the scan cannot see them.
    for (const src of [
      "async function f() { btn['disabled'] = true; await confirmDialog({ doc }); }",
      "async function f() { btn.setAttribute('disabled', 'true'); await confirmDialog({ doc }); }",
    ]) {
      expect(disablesTriggerBeforeDialog(src), src).toHaveLength(1);
    }
  });

  it('there is nothing to exempt', () => {
    // Principle #12's bite-check, in the only form it can take on an empty
    // list: assert the list is empty, and assert the file that would most
    // plausibly be added to it is genuinely in the scan. `every exclusion would
    // actually fail without it` below holds for every future entry.
    expect(DEFINING_ARTIFACTS).toEqual([]);
    expect(scannedSources().map((s) => s.rel)).toContain('ui/confirm-dialog.ts');
  });

  it('every exclusion would actually fail without it', () => {
    // The property that separates a principle-#12 exclusion from a hole: the
    // file must TRIP THE RULE. Vacuous today by construction, and that is the
    // point — it is here so the first entry has to earn itself.
    for (const entry of DEFINING_ARTIFACTS) {
      expect(
        disablesTriggerBeforeDialog(read(entry.file)),
        `${entry.file} is excluded but trips nothing — that is a hole, not an exclusion.`,
      ).not.toEqual([]);
      expect(entry.because.length, `${entry.file} exclusion needs a reason`).toBeGreaterThan(30);
    }
  });

  it('these are the shapes it does not close, and that is a decision', () => {
    // Named rather than patched, so the next round finds a boundary instead of
    // a surprise. Each needs either dataflow or a guess about what a callee
    // does with a callback, and this guard's whole inherited history is
    // patterns that guessed wrong in a way nobody could see.
    const open: [string, string][] = [
      [
        'the disable hidden behind a helper',
        'function busy() { btn.disabled = true; }\nasync function f() { busy(); await confirmDialog({ doc }); }',
      ],
      [
        'a computed value rather than the literal true',
        'async function f() { btn.disabled = busy; await confirmDialog({ doc }); }',
      ],
      [
        'a callback the enclosing body does not await',
        'function f() { btn.disabled = true; void run({ confirm: () => confirmDialog({ doc }) }); }',
      ],
      [
        'the dialog reached through an imported wrapper',
        "import { askToDelete } from './ask.js';\nasync function f() { btn.disabled = true; await askToDelete(); }",
      ],
    ];
    for (const [label, src] of open) {
      expect(disablesTriggerBeforeDialog(src), label).toEqual([]);
    }
    // The nearest CLOSED neighbour of each, so "open" describes a boundary
    // rather than a rule that never fires.
    expect(
      disablesTriggerBeforeDialog(
        'async function f() { btn.disabled = true; await confirmDialog({ doc }); }',
      ),
    ).toHaveLength(1);
  });
});
