// One code path renders a Salesforce error. This is the check that keeps it one.
//
// PR #308 fixed sixteen surfaces, ONE AT A TIME, that were mis-rendering an org
// error — collapsing our guidance line into the org's own text, and in several
// cases discarding the org's error entirely. Every one of those sixteen was a
// separate hand-roll of the same six lines:
//
//     const panel = doc.createElement('div');
//     panel.classList.add('sfdt-console', 'sfdt-error');
//     panel.textContent = err instanceof Error ? err.message : String(err);
//
// Fixing them individually left the cause untouched: nothing stopped the
// seventeenth. The two behavioural guards that came out of #308 —
// `error-render-newlines.test.ts` and `sf-error-guidance.test.ts` — pin what a
// correct panel LOOKS like, but a brand-new hand-roll that happens to satisfy
// both still passes them. This one pins the code PATH, which is the only thing
// that makes the next regression unavailable rather than merely unlikely.
//
// The rule: `.sfdt-console` + `.sfdt-error` on the same element is the
// Salesforce-error block, and only `ui/panels.ts` may build it. Everything else
// calls `renderSfError()` / `setSfError()`.
//
// It is deliberately NOT a rule about `.sfdt-error` alone: that class is also
// the red variant of `.sfdt-pill`, which several features legitimately apply to
// a status chip. The PAIR is what identifies the panel.
//
// Golden principle #12 — a check excludes the artifacts that define it. The
// helper's own implementation, the stylesheet that declares the classes, this
// file, and the docs describing the fix are all excluded below, by name and
// with a reason.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SFDT_COMPONENT_CSS } from '../lib/ui-styles.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// Every directory that ships DOM-building code. `test/` is not scanned: a test
// asserting on the rendered class pair is describing the contract, not
// violating it (principle #12), and this file is itself the proof.
const SCANNED_DIRS = ['features', 'ui', 'entrypoints', 'lib'];

// The artifacts that DEFINE the rule, each with the reason it cannot be a
// violation. Anything not on this list that names the pair is one.
const DEFINING_ARTIFACTS: { file: string; because: string }[] = [
  {
    file: 'ui/panels.ts',
    because: 'the implementation — this is the one place allowed to build the block',
  },
  {
    file: 'lib/ui-styles.ts',
    because: 'the stylesheet that declares `.sfdt-console.sfdt-error`, and the comment at ' +
      '`.sfdt-callout` that tells a caller which of the two to reach for',
  },
];

const CONSOLE_CLASS = 'sfdt-console';
const ERROR_CLASS = 'sfdt-error';

/**
 * The class pair applied to one element, in either shape the codebase uses:
 *
 *     el.className = 'sfdt-console sfdt-error'
 *     el.classList.add('sfdt-console', 'sfdt-error')
 *
 * Read as a single assignment rather than as two loose occurrences of the class
 * names, so a file that puts `.sfdt-console` on an output pane and `.sfdt-error`
 * on a status pill — which several legitimately do — is not flagged.
 */
const CLASS_APPLICATION = /\.(?:className\s*=\s*(['"`][^'"`]*['"`])|classList\.add\(([^)]*)\))/g;

export function appliesSfErrorPair(source: string): boolean {
  for (const m of source.matchAll(CLASS_APPLICATION)) {
    const args = m[1] ?? m[2] ?? '';
    const classes = new Set<string>();
    for (const quoted of args.matchAll(/['"`]([^'"`]*)['"`]/g)) {
      for (const cls of quoted[1]!.trim().split(/\s+/)) classes.add(cls);
    }
    if (classes.has(CONSOLE_CLASS) && classes.has(ERROR_CLASS)) return true;
  }
  return false;
}

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

describe('only ui/panels.ts builds the Salesforce error panel', () => {
  it('no feature, entrypoint or lib module hand-rolls the error block', () => {
    const offenders = sourceFiles()
      .map((abs) => path.relative(ROOT, abs))
      .filter((rel) => !isDefining(rel))
      .filter((rel) => appliesSfErrorPair(readFileSync(path.join(ROOT, rel), 'utf8')));

    expect(
      offenders,
      'these build the Salesforce error panel themselves instead of calling ' +
        `renderSfError()/setSfError() from ui/panels.ts:\n${offenders.join('\n')}\n\n` +
        'If the text is OUR prose rather than an org error, `.sfdt-callout` is the right ' +
        'target — see the comment at `.sfdt-callout` in lib/ui-styles.ts.',
    ).toEqual([]);
  });

  it('scans the files it claims to', () => {
    // A file-scan assertion that silently matched nothing stays green forever.
    // These four are the surfaces #308 had to fix one at a time.
    const scanned = new Set(sourceFiles().map((abs) => path.relative(ROOT, abs)));
    for (const rel of [
      'features/soql-runner.ts',
      'features/apex-anonymous.ts',
      'features/org-limits.ts',
      'entrypoints/content.ts',
    ]) {
      expect(scanned.has(rel), `${rel} must be in the scan`).toBe(true);
    }
    expect(scanned.size).toBeGreaterThan(60);
  });

  it('the guard actually detects a hand-roll', () => {
    // Both shapes the sixteen used, verbatim.
    expect(appliesSfErrorPair("panel.classList.add('sfdt-console', 'sfdt-error');")).toBe(true);
    expect(appliesSfErrorPair("logPane.className = 'sfdt-console sfdt-error';")).toBe(true);
    // …and the shape a migrated file has instead.
    expect(appliesSfErrorPair('results.appendChild(renderSfError(err, { doc }));')).toBe(false);
  });

  it('does not flag the class pair spread across two different elements', () => {
    // `.sfdt-error` is also the red `.sfdt-pill`. A file with an output console
    // and a failure chip names both classes and hand-rolls nothing — flagging
    // it would mean editing correct code to satisfy a check.
    const legitimate = [
      "logPane.className = 'sfdt-console';",
      "pill.className = row.ok ? 'sfdt-pill sfdt-success' : 'sfdt-pill sfdt-error';",
    ].join('\n');
    expect(appliesSfErrorPair(legitimate)).toBe(false);
  });

  it('every migrated surface reaches the helper by import', () => {
    // The negative rule above is satisfiable by rendering no error at all. This
    // is the positive half: the surfaces that DO show an org error must be
    // importing the shared builder.
    for (const rel of [
      'features/soql-runner.ts',
      'features/soap-explore.ts',
      'features/rest-explore.ts',
      'features/apex-anonymous.ts',
      'features/apex-test-runner.ts',
      'features/debug-log-viewer.ts',
      'features/trace-flags.ts',
      'features/dependency-explorer.ts',
      'features/ai-assistant.ts',
      'features/field-impact.ts',
      'features/flow-quality.ts',
      'features/flow-trigger-explorer-enhancer.ts',
      'features/bridge-tools.ts',
      'features/code-coverage.ts',
      'features/org-limits.ts',
      'features/schema-browser.ts',
    ]) {
      const source = readFileSync(path.join(ROOT, rel), 'utf8');
      expect(source, `${rel} must render org errors through ui/panels.ts`).toMatch(
        /import \{[^}]*(?:renderSfError|setSfError)[^}]*\} from '\.\.\/ui\/panels\.js'/s,
      );
    }
  });

  it('every defining artifact still exists and still defines something', () => {
    // Stops the exclusion list rotting into a hole: an entry that no longer
    // names the pair is an exclusion nobody needs, and one whose file has moved
    // silently widens the scan's blind spot.
    for (const entry of DEFINING_ARTIFACTS) {
      const source = readFileSync(path.join(ROOT, entry.file), 'utf8');
      expect(
        source.includes(CONSOLE_CLASS) && source.includes(ERROR_CLASS),
        `stale exclusion: ${entry.file} no longer names the error-panel classes`,
      ).toBe(true);
      expect(entry.because.length, `${entry.file} exclusion needs a reason`).toBeGreaterThan(30);
    }
  });
});

describe('the rendered parts are styled by the shared sheet', () => {
  // The helper emits `<span>`s, which are inline by default. Without these two
  // rules the org's text and the guidance sit on one line — the exact defect,
  // reintroduced from the other end.
  it('both parts are laid out as blocks and keep their own newlines', () => {
    for (const cls of ['sfdt-sf-error-text', 'sfdt-sf-error-note']) {
      const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(SFDT_COMPONENT_CSS);
      expect(rule, `${cls} must be declared in lib/ui-styles.ts`).not.toBeNull();
      expect(rule![1], `${cls} must be a block`).toMatch(/display:\s*block/);
      expect(rule![1], `${cls} must keep newlines`).toMatch(/white-space:\s*pre-wrap/);
    }
  });

  it('the note is body text, not more error text', () => {
    // Our advice in the same alarm colour as the org's message reads as more of
    // the failure. Both are theme tokens, so this is right in light and dark.
    const rule = /\.sfdt-sf-error-note\s*\{([^}]*)\}/.exec(SFDT_COMPONENT_CSS)![1]!;
    expect(rule).toContain('var(--sfdt-color-text)');
    expect(rule).not.toContain('#');
  });
});
