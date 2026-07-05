/**
 * API v67 (Summer '26) readiness scanner.
 *
 * Salesforce API version 67 makes Apex user-mode-by-default:
 *   - `WITH SECURITY_ENFORCED` no longer compiles at v67 (severity: error).
 *   - Top-level classes declared without a sharing keyword default to
 *     `with sharing` instead of implicit sharing bypass (severity: warn).
 *   - `without sharing` classes that perform SOQL/DML likely rely on system
 *     mode and should be reviewed (severity: info).
 *
 * Everything here is pure over file contents except {@link scanApexReadiness},
 * which walks the configured package directories and delegates each file to
 * {@link analyzeApexSource}.
 *
 * Design decisions / limitations (documented on purpose):
 *   - Only the FIRST top-level type declaration per `.cls` file is inspected
 *     for sharing keywords (Apex allows exactly one outer type per file);
 *     nested classes are ignored per the readiness plan (they inherit the
 *     effective sharing context of their enclosing execution).
 *   - `@IsTest` classes are EXCLUDED from the `missing-sharing` check: test
 *     classes run against synthetic data and a sharing default change does
 *     not alter production behaviour — including them would only add noise.
 *   - The sanitizer strips single-quoted strings (with `\` escapes),
 *     `'''...'''` multiline string blocks, `//` line comments, and slash-star
 *     block comments before matching, so commented-out or quoted code does
 *     not produce findings. The sanitizer is a lightweight state machine, not
 *     a parser: pathological nesting (e.g. an unterminated string literal)
 *     degrades to over-stripping the remainder of the file rather than
 *     producing false positives.
 *   - `WITH SECURITY_ENFORCED` is matched per line; a clause split across
 *     lines (`WITH\n  SECURITY_ENFORCED`) is not detected.
 */

import path from 'path';
import fs from 'fs-extra';
import { glob } from 'glob';

/** The API version at which user-mode-by-default takes effect. */
export const API_V67 = 67;

/**
 * Strip string literals and comments from Apex source while preserving the
 * exact line structure (stripped characters become spaces, newlines are
 * kept), so downstream regex matches report accurate line numbers.
 *
 * Handles: single-quoted strings with backslash escapes, `'''...'''`
 * multiline string blocks, `//` line comments, and block comments.
 *
 * @param {string} source - Raw Apex source.
 * @returns {string} Sanitized source with identical line count.
 */
export function sanitizeApexSource(source) {
  const src = String(source ?? '');
  const out = [];
  let state = 'code'; // code | string | triple | line-comment | block-comment
  let i = 0;

  while (i < src.length) {
    const ch = src[i];

    if (ch === '\n') {
      out.push('\n');
      if (state === 'line-comment') state = 'code';
      i += 1;
      continue;
    }

    if (state === 'code') {
      if (src.startsWith("'''", i)) {
        state = 'triple';
        out.push('   ');
        i += 3;
      } else if (ch === "'") {
        state = 'string';
        out.push(' ');
        i += 1;
      } else if (src.startsWith('//', i)) {
        state = 'line-comment';
        out.push('  ');
        i += 2;
      } else if (src.startsWith('/*', i)) {
        state = 'block-comment';
        out.push('  ');
        i += 2;
      } else {
        out.push(ch);
        i += 1;
      }
      continue;
    }

    if (state === 'string') {
      if (ch === '\\') {
        out.push('  ');
        i += 2;
      } else {
        if (ch === "'") state = 'code';
        out.push(' ');
        i += 1;
      }
      continue;
    }

    if (state === 'triple') {
      if (src.startsWith("'''", i)) {
        state = 'code';
        out.push('   ');
        i += 3;
      } else {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    if (state === 'block-comment') {
      if (src.startsWith('*/', i)) {
        state = 'code';
        out.push('  ');
        i += 2;
      } else {
        out.push(' ');
        i += 1;
      }
      continue;
    }

    // line-comment: swallow until newline
    out.push(' ');
    i += 1;
  }

  return out.join('');
}

const SECURITY_ENFORCED_RE = /\bWITH\s+SECURITY_ENFORCED\b/i;
const TYPE_DECL_RE = /\b(class|interface|enum)\s+[A-Za-z_]\w*/i;
const SHARING_RE = /\b(with|without|inherited)\s+sharing\b/i;
const IS_TEST_RE = /@IsTest\b/i;
const SOQL_RE = /\[\s*(?:SELECT|FIND)\b/i;
const DML_STATEMENT_RE = /(?:^|[^.\w])(?:insert|update|upsert|delete|undelete|merge)\s+[\w([]/im;
const DATABASE_CALL_RE = /\bDatabase\s*\.\s*(?:insert|update|upsert|delete|undelete|merge|query|queryWithBinds|countQuery|getQueryLocator)\s*\(/i;

function lineNumberAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Analyze a single Apex source string for v67 readiness findings.
 *
 * Pure function — no filesystem access.
 *
 * @param {string} source - Raw Apex source content.
 * @param {string} file - File path used in findings (any format; passed through).
 * @returns {Array<{type: string, file: string, line: number, snippet: string, severity: 'error'|'warn'|'info'}>}
 */
export function analyzeApexSource(source, file) {
  const raw = String(source ?? '');
  const sanitized = sanitizeApexSource(raw);
  const rawLines = raw.split('\n');
  const sanitizedLines = sanitized.split('\n');
  const findings = [];

  // 1. WITH SECURITY_ENFORCED — fails to compile at v67.
  sanitizedLines.forEach((line, idx) => {
    if (SECURITY_ENFORCED_RE.test(line)) {
      findings.push({
        type: 'security-enforced',
        file,
        line: idx + 1,
        snippet: (rawLines[idx] ?? '').trim(),
        severity: 'error',
      });
    }
  });

  // Sharing checks apply to classes only (.cls); triggers have no sharing keyword.
  if (!file.endsWith('.cls')) return findings;

  const declMatch = TYPE_DECL_RE.exec(sanitized);
  if (!declMatch || declMatch[1].toLowerCase() !== 'class') return findings;

  const declLine = lineNumberAt(sanitized, declMatch.index);
  const header = sanitized.slice(0, declMatch.index);
  const snippet = (rawLines[declLine - 1] ?? '').trim();
  const sharingMatch = SHARING_RE.exec(header);
  const isTest = IS_TEST_RE.test(header);

  // 2. Missing sharing keyword — behaviour changes to `with sharing` at v67.
  if (!sharingMatch && !isTest) {
    findings.push({
      type: 'missing-sharing',
      file,
      line: declLine,
      snippet,
      severity: 'warn',
    });
  }

  // 3. `without sharing` classes doing SOQL/DML — likely rely on system mode.
  if (sharingMatch && sharingMatch[1].toLowerCase() === 'without') {
    const body = sanitized.slice(declMatch.index);
    if (SOQL_RE.test(body) || DML_STATEMENT_RE.test(body) || DATABASE_CALL_RE.test(body)) {
      findings.push({
        type: 'system-mode-dml',
        file,
        line: declLine,
        snippet,
        severity: 'info',
      });
    }
  }

  return findings;
}

/**
 * Tally findings by severity.
 *
 * @param {Array<{severity: string}>} findings
 * @returns {{errors: number, warnings: number, info: number}}
 */
export function summarizeFindings(findings) {
  const summary = { errors: 0, warnings: 0, info: 0 };
  for (const f of findings) {
    if (f.severity === 'error') summary.errors += 1;
    else if (f.severity === 'warn') summary.warnings += 1;
    else summary.info += 1;
  }
  return summary;
}

/**
 * Whether the readiness report should fail the build: blocking errors exist
 * AND the project already targets API v67+ (below v67 the errors are
 * advisory — the code still compiles today).
 *
 * @param {{apiVersion: number|null, summary: {errors: number}}} report
 * @returns {boolean}
 */
export function shouldFailBuild(report) {
  return (
    report.summary.errors > 0 &&
    report.apiVersion != null &&
    report.apiVersion >= API_V67
  );
}

/**
 * Scan the project's Apex sources (`*.cls`, `*.trigger`) under the configured
 * package directories (falling back to `defaultSourcePath`) and return a
 * readiness report.
 *
 * @param {object} config - Loaded sfdt config (needs `_projectRoot`, and
 *   optionally `packageDirectories`, `defaultSourcePath`, `sourceApiVersion`).
 * @returns {Promise<{apiVersion: number|null, findings: object[], summary: {errors: number, warnings: number, info: number}}>}
 */
export async function scanApexReadiness(config) {
  const projectRoot = config._projectRoot;
  const roots = config.packageDirectories?.length
    ? config.packageDirectories.map(
        (d) => d.absolutePath ?? path.join(projectRoot, d.path),
      )
    : [path.join(projectRoot, config.defaultSourcePath ?? 'force-app/main/default')];

  const files = new Set();
  for (const root of roots) {
    if (!(await fs.pathExists(root))) continue;
    const matches = await glob('**/*.{cls,trigger}', {
      cwd: root,
      nodir: true,
      absolute: true,
    });
    for (const m of matches) files.add(m);
  }

  const findings = [];
  for (const file of [...files].sort()) {
    const source = await fs.readFile(file, 'utf8');
    const relative = path.relative(projectRoot, file);
    findings.push(...analyzeApexSource(source, relative));
  }

  const parsed = Number.parseFloat(config.sourceApiVersion);
  const apiVersion = Number.isFinite(parsed) ? parsed : null;

  return { apiVersion, findings, summary: summarizeFindings(findings) };
}
