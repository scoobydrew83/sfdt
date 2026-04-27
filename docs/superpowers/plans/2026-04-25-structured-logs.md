# Structured Log Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ad-hoc log file formats with a unified JSON envelope across test-run, preflight, drift, and quality logs — machine-parseable by any tool, with both a latest file and a timestamped archive per run.

**Architecture:** A new `src/lib/log-writer.js` module owns the schema, writing, archiving, and reading of all structured logs. Shell scripts emit `SFDT_LOG:` marker lines that Node parses into typed data; `gui-server.js`'s COMMANDS runner calls `log-writer` after each run. Reader functions in `gui-server.js` are simplified to return the exact same response shapes the GUI pages already consume.

**Tech Stack:** Node.js ESM, fs-extra, vitest

---

## File Map

| File | Action |
|------|--------|
| `src/lib/log-writer.js` | **Create** — schema, write, archive, prune, readLatestLog, validateLogSchema, parseSfdtLogLines |
| `test/lib/log-writer.test.js` | **Create** — unit tests (written first, TDD) |
| `scripts/new/preflight.sh` | **Modify** — add `SFDT_LOG:check:` lines in `record_result()` |
| `scripts/new/drift.sh` | **Modify** — add `SFDT_LOG:component:` lines in the while loop |
| `src/lib/gui-server.js` | **Modify** — COMMANDS runner calls log-writer; reader functions use `readLatestLog` |
| `src/templates/sfdt.config.json` | **Modify** — add `logRetention: 50` |

> **Scope note:** Structured logs are written only when commands are run via `sfdt ui` (the GUI COMMANDS runner). Running `sfdt preflight` or `sfdt drift` directly from the CLI does not write structured log files in this implementation. CLI-path log writing is a follow-on task.

---

## Task 1: Write failing tests for log-writer.js

**Files:**
- Create: `test/lib/log-writer.test.js`

- [ ] **Step 1: Create the test file**

```js
// test/lib/log-writer.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {
  writeLog,
  readLatestLog,
  validateLogSchema,
  parseSfdtLogLines,
} from '../../src/lib/log-writer.js';

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-log-test-'));
});

afterEach(async () => {
  await fs.remove(tmpDir);
});

// ── parseSfdtLogLines ─────────────────────────────────────────────────────────

describe('parseSfdtLogLines', () => {
  it('parses check lines into checks array', () => {
    const lines = [
      'SFDT_LOG:check:branch-naming:PASS:Branch follows convention',
      'SFDT_LOG:check:coverage:FAIL:Coverage 62% below threshold 75%',
      '[PASS] branch-naming - Branch follows convention',
    ];
    const result = parseSfdtLogLines(lines);
    expect(result.checks).toEqual([
      { name: 'branch-naming', status: 'PASS', message: 'Branch follows convention' },
      { name: 'coverage', status: 'FAIL', message: 'Coverage 62% below threshold 75%' },
    ]);
    expect(result.components).toEqual([]);
  });

  it('parses component lines into components array', () => {
    const lines = [
      'SFDT_LOG:component:MyClass:ApexClass:Modified',
      'SFDT_LOG:component:MyTrigger:ApexTrigger:Added',
    ];
    const result = parseSfdtLogLines(lines);
    expect(result.components).toEqual([
      { name: 'MyClass', type: 'ApexClass', drift: 'Modified' },
      { name: 'MyTrigger', type: 'ApexTrigger', drift: 'Added' },
    ]);
    expect(result.checks).toEqual([]);
  });

  it('handles message field containing colons', () => {
    const lines = ['SFDT_LOG:check:coverage:WARN:Coverage: 70% (threshold: 75%)'];
    const result = parseSfdtLogLines(lines);
    expect(result.checks[0].message).toBe('Coverage: 70% (threshold: 75%)');
  });

  it('ignores non-SFDT_LOG lines', () => {
    const lines = ['normal output', '', 'SFDT_LOG:unknown:x:y:z'];
    const result = parseSfdtLogLines(lines);
    expect(result.checks).toEqual([]);
    expect(result.components).toEqual([]);
  });

  it('returns empty arrays for empty input', () => {
    const result = parseSfdtLogLines([]);
    expect(result.checks).toEqual([]);
    expect(result.components).toEqual([]);
  });
});

// ── validateLogSchema ─────────────────────────────────────────────────────────

describe('validateLogSchema', () => {
  it('returns true for a valid preflight log', () => {
    const log = {
      schemaVersion: '1',
      type: 'preflight',
      timestamp: '2026-04-25T14:00:00.000Z',
      durationMs: 1000,
      exitCode: 0,
      org: 'my-org',
      projectName: 'My Project',
      data: { status: 'PASS', checks: [] },
    };
    expect(validateLogSchema(log)).toBe(true);
  });

  it('returns false for missing schemaVersion', () => {
    expect(validateLogSchema({ type: 'preflight', timestamp: 'x', data: {} })).toBe(false);
  });

  it('returns false for unknown type', () => {
    expect(validateLogSchema({ schemaVersion: '1', type: 'unknown', timestamp: 'x', data: {} })).toBe(false);
  });

  it('returns false for null', () => {
    expect(validateLogSchema(null)).toBe(false);
  });

  it('returns false for missing data', () => {
    expect(validateLogSchema({ schemaVersion: '1', type: 'preflight', timestamp: 'x' })).toBe(false);
  });
});

// ── writeLog ──────────────────────────────────────────────────────────────────

describe('writeLog', () => {
  it('writes preflight-latest.json with correct envelope', async () => {
    const data = { status: 'PASS', checks: [{ name: 'git', status: 'PASS', message: 'Clean' }] };
    await writeLog(tmpDir, 'preflight', data, { org: 'dev-org', projectName: 'TestProj', exitCode: 0, durationMs: 500 });

    const written = await fs.readJson(path.join(tmpDir, 'preflight-latest.json'));
    expect(written.schemaVersion).toBe('1');
    expect(written.type).toBe('preflight');
    expect(written.org).toBe('dev-org');
    expect(written.projectName).toBe('TestProj');
    expect(written.exitCode).toBe(0);
    expect(written.durationMs).toBe(500);
    expect(written.data).toEqual(data);
    expect(typeof written.timestamp).toBe('string');
  });

  it('archives a timestamped copy in preflight-results/', async () => {
    await writeLog(tmpDir, 'preflight', { status: 'PASS', checks: [] }, {});
    const archiveDir = path.join(tmpDir, 'preflight-results');
    expect(await fs.pathExists(archiveDir)).toBe(true);
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/\.json$/);
  });

  it('prunes archive to logRetention count', async () => {
    for (let i = 0; i < 5; i++) {
      await writeLog(tmpDir, 'drift', { status: 'clean', components: [] }, { retention: 3 });
    }
    const archiveDir = path.join(tmpDir, 'drift-results');
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBe(3);
  });

  it('writes test-results/latest.json for test-run type', async () => {
    const data = { passed: 10, failed: 0, errors: 0, skipped: 0, coverage: 85, tests: [] };
    await writeLog(tmpDir, 'test-run', data, {});
    expect(await fs.pathExists(path.join(tmpDir, 'test-results', 'latest.json'))).toBe(true);
  });

  it('archives test-run into test-results/ directory', async () => {
    await writeLog(tmpDir, 'test-run', { passed: 1, failed: 0, errors: 0, skipped: 0, coverage: 90, tests: [] }, {});
    const archiveDir = path.join(tmpDir, 'test-results');
    const files = (await fs.readdir(archiveDir)).filter((f) => f !== 'latest.json');
    expect(files.length).toBe(1);
  });
});

// ── readLatestLog ─────────────────────────────────────────────────────────────

describe('readLatestLog', () => {
  it('returns null when file does not exist', async () => {
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns null for corrupt JSON', async () => {
    await fs.outputFile(path.join(tmpDir, 'preflight-latest.json'), 'not json');
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns null for file with wrong schemaVersion', async () => {
    await fs.outputJson(path.join(tmpDir, 'preflight-latest.json'), {
      schemaVersion: '99',
      type: 'preflight',
      timestamp: 'x',
      data: {},
    });
    expect(await readLatestLog(tmpDir, 'preflight')).toBeNull();
  });

  it('returns the envelope for a valid file', async () => {
    const data = { status: 'PASS', checks: [] };
    const envelope = await writeLog(tmpDir, 'preflight', data, { org: 'x', projectName: 'y', exitCode: 0, durationMs: 1 });
    const result = await readLatestLog(tmpDir, 'preflight');
    expect(result).toEqual(envelope);
  });
});
```

- [ ] **Step 2: Run tests to confirm they all fail (file doesn't exist yet)**

```bash
cd /Users/dkennedy/dev/sfdt && npx vitest run test/lib/log-writer.test.js 2>&1 | head -20
```

Expected: errors about `../../src/lib/log-writer.js` not found.

---

## Task 2: Implement log-writer.js

**Files:**
- Create: `src/lib/log-writer.js`

- [ ] **Step 1: Create the module**

```js
// src/lib/log-writer.js
import fs from 'fs-extra';
import path from 'path';

const SCHEMA_VERSION = '1';
const LOG_TYPES = ['preflight', 'test-run', 'drift', 'quality'];

const LATEST_FILES = {
  preflight: 'preflight-latest.json',
  'test-run': path.join('test-results', 'latest.json'),
  drift: 'drift-latest.json',
  quality: 'quality-latest.json',
};

const ARCHIVE_DIRS = {
  preflight: 'preflight-results',
  'test-run': 'test-results',
  drift: 'drift-results',
  quality: 'quality-results',
};

/**
 * Parse SFDT_LOG: marker lines from script stdout into structured arrays.
 * Format: SFDT_LOG:kind:name:status-or-type:message (split on first 4 colons only)
 */
export function parseSfdtLogLines(lines) {
  const checks = [];
  const components = [];

  for (const line of lines) {
    if (!line.startsWith('SFDT_LOG:')) continue;
    const parts = line.split(':');
    // parts: ['SFDT_LOG', kind, field2, field3, ...rest]
    const kind = parts[1];
    if (kind === 'check') {
      const name = parts[2];
      const status = parts[3];
      const message = parts.slice(4).join(':');
      checks.push({ name, status, message });
    } else if (kind === 'component') {
      const name = parts[2];
      const type = parts[3];
      const drift = parts[4];
      components.push({ name, type, drift });
    }
  }

  return { checks, components };
}

/**
 * Validate that an object conforms to the structured log envelope schema.
 */
export function validateLogSchema(log) {
  if (!log || typeof log !== 'object') return false;
  if (log.schemaVersion !== SCHEMA_VERSION) return false;
  if (!LOG_TYPES.includes(log.type)) return false;
  if (typeof log.timestamp !== 'string') return false;
  if (!log.data || typeof log.data !== 'object') return false;
  return true;
}

/**
 * Write a structured log for the given type.
 * Creates logs/{type}-latest.json and an archive copy.
 *
 * @param {string} logDir - Absolute path to the logs directory
 * @param {string} type - One of: preflight, test-run, drift, quality
 * @param {object} data - Type-specific payload
 * @param {object} [meta] - exitCode, durationMs, org, projectName, retention
 * @returns {object} The written envelope
 */
export async function writeLog(logDir, type, data, meta = {}) {
  const { org = '', projectName = '', exitCode = 0, durationMs = 0, retention = 50 } = meta;

  const timestamp = new Date().toISOString();
  const envelope = {
    schemaVersion: SCHEMA_VERSION,
    type,
    timestamp,
    durationMs,
    exitCode,
    org,
    projectName,
    data,
  };

  // Write latest
  const latestPath = path.join(logDir, LATEST_FILES[type]);
  await fs.outputJson(latestPath, envelope, { spaces: 2 });

  // Archive (timestamped filename — colons replaced so it's filesystem-safe)
  const archiveDir = path.join(logDir, ARCHIVE_DIRS[type]);
  await fs.ensureDir(archiveDir);
  const archiveName = timestamp.replace(/:/g, '-').replace(/\./g, '-') + '.json';
  await fs.outputJson(path.join(archiveDir, archiveName), envelope, { spaces: 2 });

  // Prune oldest archives beyond retention limit
  const entries = (await fs.readdir(archiveDir))
    .filter((f) => f.endsWith('.json') && f !== 'latest.json')
    .sort();
  if (entries.length > retention) {
    const toDelete = entries.slice(0, entries.length - retention);
    await Promise.all(toDelete.map((f) => fs.remove(path.join(archiveDir, f))));
  }

  return envelope;
}

/**
 * Read and validate the latest structured log for the given type.
 * Returns the envelope object or null if missing, corrupt, or schema-invalid.
 */
export async function readLatestLog(logDir, type) {
  const filePath = path.join(logDir, LATEST_FILES[type]);
  try {
    const log = await fs.readJson(filePath);
    if (!validateLogSchema(log)) return null;
    return log;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Run tests — expect them to pass**

```bash
cd /Users/dkennedy/dev/sfdt && npx vitest run test/lib/log-writer.test.js
```

Expected: all tests pass.

- [ ] **Step 3: Run full test suite to confirm no regressions**

```bash
cd /Users/dkennedy/dev/sfdt && npm test
```

Expected: all existing tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/log-writer.js test/lib/log-writer.test.js
git commit -m "feat: add log-writer module with structured log schema"
```

---

## Task 3: Update preflight.sh to emit SFDT_LOG: marker lines

**Files:**
- Modify: `scripts/new/preflight.sh`

The `record_result()` function at line 27 currently collects results for human display only. Add `echo "SFDT_LOG:check:..."` before each `RESULTS+=` so the Node layer can parse structured check data alongside the human-readable output.

- [ ] **Step 1: Modify record_result() to emit SFDT_LOG lines**

Replace the `record_result()` function (lines 27–37) with:

```bash
record_result() {
    local status="$1"
    local check="$2"
    local detail="${3:-}"

    # Emit machine-readable marker for Node log-writer (stripped before display)
    echo "SFDT_LOG:check:${check}:${status}:${detail}"

    case "$status" in
        PASS) PASS_COUNT=$((PASS_COUNT + 1)); RESULTS+=("$(print_success "[PASS] ${check}${detail:+ - ${detail}}")") ;;
        FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)); RESULTS+=("$(print_error "[FAIL] ${check}${detail:+ - ${detail}}")") ;;
        WARN) WARN_COUNT=$((WARN_COUNT + 1)); RESULTS+=("$(print_warning "[WARN] ${check}${detail:+ - ${detail}}")") ;;
    esac
}
```

- [ ] **Step 2: Verify the script still runs without error (dry-run)**

```bash
cd /Users/dkennedy/dev/sfdt && bash -n scripts/new/preflight.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/new/preflight.sh
git commit -m "feat: emit SFDT_LOG:check: markers in preflight.sh for structured logging"
```

---

## Task 4: Update drift.sh to emit SFDT_LOG: marker lines

**Files:**
- Modify: `scripts/new/drift.sh`

The while loop at lines 73–93 categorizes file entries into `ADDED`, `MODIFIED`, and `DELETED` arrays. Add `echo "SFDT_LOG:component:..."` inside each case arm.

- [ ] **Step 1: Modify the while loop in drift.sh**

Replace the while loop (lines 73–93) with:

```bash
while IFS='|' read -r state name; do
    [[ -z "$state" ]] && continue
    case "$state" in
        Add|Created|add)
            ADDED+=("$name")
            ADD_COUNT=$((ADD_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Added"
            ;;
        Changed|Modified|modify|Modify)
            MODIFIED+=("$name")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Modified"
            ;;
        Delete|Deleted|delete)
            DELETED+=("$name")
            DELETE_COUNT=$((DELETE_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Deleted"
            ;;
        *)
            MODIFIED+=("${state}: ${name}")
            MODIFY_COUNT=$((MODIFY_COUNT + 1))
            echo "SFDT_LOG:component:${name}:Unknown:Modified"
            ;;
    esac
done <<< "$FILE_ENTRIES"
```

Note: The SF CLI preview output doesn't include the metadata type separately from the name (the `fullName` field is typically `TypeName/MemberName`). We use `Unknown` as the type placeholder — the GUI currently doesn't filter by type in the drift view. If type data becomes available, this can be refined.

- [ ] **Step 2: Verify syntax**

```bash
bash -n /Users/dkennedy/dev/sfdt/scripts/new/drift.sh && echo "Syntax OK"
```

Expected: `Syntax OK`

- [ ] **Step 3: Commit**

```bash
git add scripts/new/drift.sh
git commit -m "feat: emit SFDT_LOG:component: markers in drift.sh for structured logging"
```

---

## Task 5: Update gui-server.js COMMANDS runner to call log-writer

**Files:**
- Modify: `src/lib/gui-server.js`

The COMMANDS generic SSE runner (starting at line 533) currently writes `{ date, command, exitCode, lines }` as a raw blob. Replace that write (lines 602–604) with a structured log write for the 4 typed commands; non-typed commands (deploy, rollback) keep the existing raw write.

- [ ] **Step 1: Import log-writer at the top of gui-server.js**

Add after the existing imports (near line 16):

```js
import { writeLog, parseSfdtLogLines, readLatestLog } from './log-writer.js';
```

- [ ] **Step 2: Add a helper to extract test-run data from captured lines**

Add this function near the top of the file, after the `tryReadJson` helper:

```js
/**
 * Extract test-run data from SF CLI --json output captured in lines[].
 * Handles sf apex run test JSON format variations.
 */
function parseTestRunLines(lines) {
  const jsonLine = lines.find((l) => {
    try { const p = JSON.parse(l); return p && (p.result || p.summary || Array.isArray(p)); }
    catch { return false; }
  });
  if (!jsonLine) return { passed: 0, failed: 0, errors: 0, skipped: 0, coverage: null, tests: [] };
  const raw = JSON.parse(jsonLine);
  const summary = raw.result?.summary ?? raw.summary ?? {};
  const tests = (raw.result?.tests ?? raw.tests ?? []).map((t) => ({
    name: t.methodName ?? t.name ?? 'unknown',
    status: t.outcome ?? t.status ?? 'unknown',
    durationMs: t.runTime ?? null,
    message: t.message ?? null,
  }));
  return {
    passed: summary.passing ?? 0,
    failed: summary.failing ?? 0,
    errors: summary.skipped ?? 0,
    skipped: 0,
    coverage: summary.testRunCoverage ? parseFloat(summary.testRunCoverage) : null,
    tests,
  };
}

/**
 * Extract quality data from SF CLI scanner --json output captured in lines[].
 */
function parseQualityLines(lines) {
  const jsonLine = lines.find((l) => {
    try { const p = JSON.parse(l); return p && (Array.isArray(p.result) || Array.isArray(p)); }
    catch { return false; }
  });
  if (!jsonLine) return { status: 'PASS', summary: { critical: 0, high: 0, medium: 0, low: 0 }, violations: [] };
  const raw = JSON.parse(jsonLine);
  const rawViolations = Array.isArray(raw.result) ? raw.result : Array.isArray(raw) ? raw : [];
  const violations = rawViolations.flatMap((file) =>
    (file.violations ?? []).map((v) => ({
      file: file.fileName ?? '',
      line: v.line ?? 0,
      rule: v.ruleName ?? v.rule ?? '',
      severity: v.severity ?? 3,
      message: v.message ?? '',
    }))
  );
  const summary = violations.reduce(
    (acc, v) => {
      if (v.severity === 1) acc.critical++;
      else if (v.severity === 2) acc.high++;
      else if (v.severity === 3) acc.medium++;
      else acc.low++;
      return acc;
    },
    { critical: 0, high: 0, medium: 0, low: 0 }
  );
  return {
    status: violations.length === 0 ? 'PASS' : 'FAIL',
    summary,
    violations,
  };
}
```

- [ ] **Step 3: Define the set of structured log types**

Add just before the `COMMANDS` definition (line 285):

```js
// Log types that get written as structured logs via log-writer
const STRUCTURED_LOG_TYPES = new Set(['preflight', 'drift', 'test', 'quality']);
```

- [ ] **Step 4: Replace the raw log write with a structured log write**

Find the block at lines 602–604:

```js
      const logPayload = { date: new Date().toISOString(), command, exitCode, lines };
      const logFilePath = path.join(projectRoot, cmd.logFile);
      await fs.outputJson(logFilePath, logPayload, { spaces: 2 });
```

Replace it with:

```js
      const runDurationMs = Date.now() - startTime;
      if (STRUCTURED_LOG_TYPES.has(command)) {
        // Build type-specific data from captured lines
        let logType = command === 'test' ? 'test-run' : command;
        let data;
        if (command === 'preflight') {
          const { checks } = parseSfdtLogLines(lines);
          const hasFailure = checks.some((c) => c.status === 'FAIL');
          const hasWarn = checks.some((c) => c.status === 'WARN');
          data = {
            status: hasFailure ? 'FAIL' : hasWarn ? 'WARN' : 'PASS',
            checks,
          };
        } else if (command === 'drift') {
          const { components } = parseSfdtLogLines(lines);
          data = {
            status: components.length > 0 ? 'drift' : 'clean',
            components,
          };
        } else if (command === 'test') {
          data = parseTestRunLines(lines);
        } else if (command === 'quality') {
          data = parseQualityLines(lines);
        }
        await writeLog(logDir, logType, data, {
          org: config.defaultOrg ?? '',
          projectName: config.projectName ?? '',
          exitCode,
          durationMs: runDurationMs,
          retention: config.logRetention ?? 50,
        });
      } else {
        // Non-structured commands (deploy, rollback) keep raw format
        const logPayload = { date: new Date().toISOString(), command, exitCode, lines };
        const logFilePath = path.join(projectRoot, cmd.logFile);
        await fs.outputJson(logFilePath, logPayload, { spaces: 2 });
      }
```

- [ ] **Step 5: Add the startTime capture before the child process launch**

Find the line `let child;` (around line 547) and add `const startTime = Date.now();` immediately after:

```js
    let child;
    const startTime = Date.now();
```

- [ ] **Step 6: Run the full test suite**

```bash
cd /Users/dkennedy/dev/sfdt && npm test
```

Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/gui-server.js
git commit -m "feat: write structured logs from gui-server COMMANDS runner"
```

---

## Task 6: Update gui-server.js reader functions to use readLatestLog

**Files:**
- Modify: `src/lib/gui-server.js`

Replace the three ad-hoc reader functions with simplified versions that call `readLatestLog` and normalize output to the exact same response shapes the GUI pages already consume. This preserves GUI parity — the API response shapes are frozen.

- [ ] **Step 1: Replace readTestRuns**

Find the `readTestRuns` function (lines 43–103) and replace with:

```js
/**
 * Scan for test-run structured logs (new format) plus any legacy SF CLI files.
 * Returns an array of run objects: { date, passed, failed, errors, coverage, duration }.
 * GUI parity: response shape is unchanged.
 */
async function readTestRuns(logDir) {
  const resultsDir = path.join(logDir, 'test-results');
  if (!(await fs.pathExists(resultsDir))) return [];

  let entries;
  try {
    entries = await fs.readdir(resultsDir);
  } catch {
    return [];
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse(); // newest first

  const runs = [];

  for (const file of jsonFiles) {
    const raw = await tryReadJson(path.join(resultsDir, file));
    if (!raw) continue;

    // New structured envelope format
    if (raw.schemaVersion === '1' && raw.type === 'test-run') {
      const d = raw.data ?? {};
      runs.push({
        date: raw.timestamp,
        passed: d.passed ?? 0,
        failed: d.failed ?? 0,
        errors: d.errors ?? 0,
        coverage: d.coverage ?? undefined,
        duration: raw.durationMs ?? undefined,
      });
      continue;
    }

    // Legacy SF CLI formats
    if (raw.result) {
      const r = raw.result;
      runs.push({
        date: r.summary?.testStartTime ?? raw.timestamp ?? file,
        passed: r.summary?.passing ?? 0,
        failed: r.summary?.failing ?? 0,
        errors: r.summary?.skipped ?? 0,
        coverage: r.summary?.testRunCoverage ? parseFloat(r.summary.testRunCoverage) : undefined,
        duration: r.summary?.testExecutionTimeInMs ?? undefined,
      });
    } else if (raw.summary) {
      runs.push({
        date: raw.summary.testStartTime ?? raw.timestamp ?? file,
        passed: raw.summary.passing ?? 0,
        failed: raw.summary.failing ?? 0,
        errors: raw.summary.skipped ?? 0,
        coverage: raw.summary.testRunCoverage ? parseFloat(raw.summary.testRunCoverage) : undefined,
        duration: raw.summary.testExecutionTimeInMs ?? undefined,
      });
    } else if (Array.isArray(raw)) {
      const passed = raw.filter((t) => t.outcome === 'Pass').length;
      const failed = raw.filter((t) => t.outcome === 'Fail').length;
      runs.push({ date: raw[0]?.testTimestamp ?? file, passed, failed, errors: 0 });
    }
  }

  return runs;
}
```

- [ ] **Step 2: Replace readPreflight**

Find `readPreflight` (lines 110–124) and replace with:

```js
/**
 * Read the most recent preflight log.
 * Returns { date, status, checks: [{name, status, message}] } or null.
 * GUI parity: response shape is unchanged.
 */
async function readPreflight(logDir) {
  const log = await readLatestLog(logDir, 'preflight');
  if (log) {
    return { date: log.timestamp, status: log.data.status, checks: log.data.checks ?? [] };
  }

  // Legacy fallback: old preflight_*.json files
  const files = await safeReaddir(logDir);
  const legacyFiles = files
    .filter((f) => f.startsWith('preflight_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!legacyFiles.length) return null;
  return tryReadJson(path.join(logDir, legacyFiles[0]));
}
```

- [ ] **Step 3: Replace readDrift**

Find `readDrift` (lines 130–143) and replace with:

```js
/**
 * Read the most recent drift log.
 * Returns { date, status, components: [{name, type, drift}] } or null.
 * GUI parity: response shape is unchanged.
 */
async function readDrift(logDir) {
  const log = await readLatestLog(logDir, 'drift');
  if (log) {
    return { date: log.timestamp, status: log.data.status, components: log.data.components ?? [] };
  }

  // Legacy fallback
  const files = await safeReaddir(logDir);
  const legacyFiles = files
    .filter((f) => f.startsWith('drift_') && f.endsWith('.json'))
    .sort()
    .reverse();
  if (!legacyFiles.length) return null;
  return tryReadJson(path.join(logDir, legacyFiles[0]));
}
```

- [ ] **Step 4: Verify the import from Task 5 Step 1 includes readLatestLog**

The import line added in Task 5 Step 1 should already read:

```js
import { writeLog, parseSfdtLogLines, readLatestLog } from './log-writer.js';
```

If it doesn't, update it now.

- [ ] **Step 5: Run the full test suite**

```bash
cd /Users/dkennedy/dev/sfdt && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/lib/gui-server.js
git commit -m "feat: simplify gui-server log readers to use readLatestLog with legacy fallback"
```

---

## Task 7: Add logRetention to config template

**Files:**
- Modify: `src/templates/sfdt.config.json`

- [ ] **Step 1: Add logRetention field**

Add `"logRetention": 50` as a top-level key after `"pullCache"`:

```json
{
  "projectName": "",
  "defaultOrg": "",
  "releaseNotesDir": "release-notes",
  "manifestDir": "manifest/release",
  "deployment": {
    "coverageThreshold": 75,
    "preflight": {
      "enforceTests": false,
      "enforceBranchNaming": false,
      "enforceChangelog": false
    }
  },
  "features": {
    "ai": true,
    "notifications": false,
    "releaseManagement": true
  },
  "ai": {
    "provider": "claude",
    "model": ""
  },
  "plugins": [],
  "pluginOptions": {
    "autoDiscover": false
  },
  "mcp": {
    "enabled": false,
    "salesforce": {
      "transport": "stdio",
      "command": "sf",
      "args": ["mcp", "start"]
    }
  },
  "pullCache": {
    "enabled": true,
    "parallelism": 5,
    "batchSize": 100,
    "retrieveTimeoutSeconds": 360
  },
  "logRetention": 50
}
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/dkennedy/dev/sfdt && npm test
```

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/templates/sfdt.config.json
git commit -m "feat: add logRetention config key (default 50 files per log type)"
```

---

## Task 8: Mark ROADMAP.md complete and final commit

- [ ] **Step 1: Update ROADMAP.md**

Change the structured log format line from:

```markdown
- [ ] **Structured log format**: standardized JSON schema for test-run, preflight, and drift log files consumed by `sfdt ui` and external observability tools.
```

To:

```markdown
- [x] **Structured log format**: unified JSON envelope (`schemaVersion`, `type`, `timestamp`, `exitCode`, `org`, `data`) for test-run, preflight, drift, and quality logs. Machine-parseable by any tool. Each run writes a timestamped archive plus `{type}-latest.json`. `sfdt ui` reader functions preserve existing API response shapes (GUI parity).
```

- [ ] **Step 2: Commit**

```bash
git add ROADMAP.md
git commit -m "docs: mark structured log format complete in ROADMAP"
```

---

## Verification Checklist

After all tasks complete, verify end-to-end:

1. `npm test` — all tests pass (no regressions, new tests green)
2. Start `sfdt ui`, run preflight from the GUI — open `logs/preflight-latest.json` and confirm the envelope shape matches the schema
3. Open the Preflight page in the browser — confirm checks display identically to before
4. Run drift from the GUI — open `logs/drift-latest.json`, confirm schema
5. Run 3 preflight runs — confirm `logs/preflight-results/` contains 3 timestamped `.json` files
6. Corrupt `logs/drift-latest.json` with invalid JSON — reload Drift page, confirm it shows "No data" gracefully (no crash, no blank screen)
7. Confirm `logs/test-results/` has both `latest.json` (envelope format) and timestamped archives alongside any older legacy files
