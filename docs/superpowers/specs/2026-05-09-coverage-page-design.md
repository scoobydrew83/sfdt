# Coverage Page — Design Spec
**Date:** 2026-05-09  
**Status:** Approved

---

## Overview

A dedicated Coverage page in the GUI sidebar that lets users run org-wide Apex test coverage, view historical trends, and drill into per-class and per-test failure detail with AI-assisted fix suggestions.

---

## Approach

**Option A — Extend existing test command infrastructure.** The Coverage page sends `{ command: 'test', testLevel: '<selection>' }` to the existing `/api/command/run` endpoint. `enhanced-test-runner.sh` branches on `SFDT_TEST_LEVEL`. Results are saved as standard `test-run` logs and read by `GET /api/test-runs` — no new API endpoints for the run path.

---

## Backend Changes

### `enhanced-test-runner.sh`

Add a branch at the top of the script:

- If `SFDT_TEST_LEVEL` is `RunLocalTests` or `RunAllTestsInOrg`:
  - Skip the class-batching logic entirely
  - Run a single `sf apex run test --test-level $SFDT_TEST_LEVEL --code-coverage --json --wait 20 --target-org $TARGET_ORG`
  - Write output to `$RESULTS_DIR/local_$TIMESTAMP.json`
  - Aggregate result using the same jq pipeline that the batch path uses
  - Emit the same compact JSON line to stdout that `parsers.js` already reads

- If `SFDT_TEST_LEVEL` is `RunSpecifiedTests` or empty:
  - Use the existing parallel class-batching path unchanged

### New endpoint: `POST /api/test/classes/sync`

- Calls the existing test class discovery logic (scans `*Test.cls` files in source path)
- Merges discovered classes into `testConfig.testClasses` in `.sfdt/config.json`
- Returns `{ added: number, removed: number, total: number }`
- If discovery returns zero classes, returns a 400 with a descriptive error — does not wipe config

### No other server changes needed

`/api/command/run` already accepts `testLevel` in the request body and maps it to `SFDT_TEST_LEVEL`. `parsers.js` `parseTestRunLines()` already reads `testRunCoverage` and `codeCoverage[]` from SF CLI JSON. `GET /api/test-runs` already returns `classCoverage[]` per run.

---

## UI Layout

New route: `coverage` added to `App.jsx` sidebar nav.  
New file: `gui/src/pages/Coverage.jsx`

### Zone 1 — Run Panel (card)

- **Picklist** (dropdown): three options
  - Run Local Tests → `testLevel: 'RunLocalTests'`
  - Run All Tests in Org → `testLevel: 'RunAllTestsInOrg'`  
  - Run Specified Classes → `testLevel: 'RunSpecifiedTests'` (uses `testConfig.testClasses`)
- **"Run Coverage" button** — label dynamically reflects selection (e.g. "Run Local Tests", "Run All Tests in Org", "Run Specified Classes"). Triggers `stream.commandRun('test', { testLevel })` via existing SSE path
- **"Sync from Source" button** — calls `POST /api/test/classes/sync`, shows inline toast with `{ added, removed, total }`
- When `RunAllTestsInOrg` is selected, display a warning note: "This may take 10+ minutes depending on org size"
- When running: card shows streaming terminal log inline (reuse `CommandRunner` component). Terminal persists after completion so the user can scroll output
- When complete: run panel returns to idle state, page refreshes run history

### Zone 2 — Summary Stat Cards (4 across)

Uses existing `StatCard` component:

| Card | Value | Color logic |
|------|-------|-------------|
| Last Coverage | `{coverage}%` | green ≥ threshold, yellow ≥ 60, red < 60 |
| Threshold | `{threshold}%` from config | neutral |
| Classes Below Threshold | count | red if > 0, green if 0 |
| Last Run | date string | neutral |

### Zone 3 — Coverage Trend (CSS timeline bars)

- Shows last 10 runs, one row per run
- Layout per row: `[date label] [████████░░] [nn%]`
- Bar width = `coverage / 100 * 100%` of a fixed container
- Bar color: green / yellow / red matching threshold logic
- Clicking a trend row filters Zone 4 table to that run's class data
- Selected run highlighted with a subtle background
- If fewer than 2 runs: show "Run coverage a few times to see trends"

### Zone 4 — Per-Class Table

**Controls above table:**
- Text input: live filters `className` (case-insensitive contains)
- Toggle: "Below threshold only" — filters to classes where `percent < threshold`
- Sort: clicking column headers cycles asc/desc. Default sort: coverage % ascending (lowest first)

**Columns:**
| Column | Notes |
|--------|-------|
| Class Name | Monospace, red text if below threshold. Clickable → opens Failing Tests Modal |
| Coverage % | Mini inline progress bar + percentage label |
| Covered Lines | Right-aligned monospace |
| Total Lines | Right-aligned monospace, muted |

**Empty states:**
- No class data for selected run: "Coverage detail not available for this run"
- Filter returns nothing: "No classes match your filter"

### Failing Tests Modal

Triggered by clicking any class row in the per-class table.

**Content:**
- Modal title: class name
- Summary line: `{passing} passing · {failing} failing · {coverage}% coverage`
- If no failures: show passing test list only, no AI button
- **Failing Tests table** (when failures exist):
  - Columns: Test Method · Error Message · Duration
  - Data sourced from `tests[]` array, filtered by `name.startsWith(className + '.')`
  - Error message truncated to 120 chars with expand toggle
- **"✦ Ask AI to fix" button** — opens `ChatContext` chat panel pre-loaded with:
  - Class name and coverage %
  - Each failing test name + error message
  - Prompt: "These tests are failing in `{ClassName}`. Can you read the source and suggest fixes?"

Modal uses same pattern as `UpdateModal` (existing component). No new dependencies.

---

## Data Flow

```
User clicks "Run Coverage"
  → POST /api/command/run { command: 'test', testLevel: 'RunLocalTests' }
  → Server sets SFDT_TEST_LEVEL=RunLocalTests
  → enhanced-test-runner.sh branches to single SF CLI call
  → sf apex run test --test-level RunLocalTests --code-coverage --json --wait 20
  → Output saved to local_$TIMESTAMP.json
  → Compact JSON emitted to stdout
  → parseTestRunLines() reads summary.testRunCoverage + result.codeCoverage[]
  → Saved as test-run log with classCoverage[] populated
  → Page refreshes via GET /api/test-runs
  → Trend bars + class table populated from same response

User clicks "Sync from Source"
  → POST /api/test/classes/sync
  → Discovery scans *Test.cls in source path
  → Writes to testConfig.testClasses in .sfdt/config.json
  → Returns { added, removed, total }
  → Toast shown inline

User clicks class row
  → Modal opens with tests[] filtered to that class
  → "Ask AI to fix" opens ChatContext with failing test context
```

---

## Error Handling

| Scenario | Behavior |
|----------|----------|
| No runs yet | Empty state with prompt to run coverage |
| Run fails (auth, timeout) | Terminal stays visible with error, history unchanged |
| RunAllTestsInOrg selected | Warning note shown before run |
| Sync returns zero classes | 400 response, inline warning shown, config not modified |
| classCoverage[] empty but coverage% present | Stat cards render, table shows empty state with explanation |
| Classes below threshold | Red highlight in table, "Classes Below Threshold" card turns red |
| Failing tests modal, no failures | Modal shows passing tests only, no AI button |

---

## Files Changed

| File | Change |
|------|--------|
| `scripts/core/enhanced-test-runner.sh` | Add `RunLocalTests`/`RunAllTestsInOrg` branch |
| `src/lib/gui-server/index.js` | Add `POST /api/test/classes/sync` endpoint |
| `gui/src/pages/Coverage.jsx` | New page (all 4 zones + modal) |
| `gui/src/App.jsx` | Add Coverage route + sidebar nav entry |
| `gui/src/api.js` | Add `api.syncTestClasses()` call |

---

## Out of Scope

- Trend charts with SVG/D3 (CSS bars only)
- Per-method coverage breakdown (SF CLI doesn't return this in standard JSON)
- Saving/exporting coverage reports to file
- Coverage comparison between runs (delta view)

---

## Implementation Plan

**Date:** 2026-05-09  
**Status:** Ready to build

### Pre-flight gap (discovered during audit)

`POST /api/command/run` does not currently forward `testLevel` from the request body into `SFDT_TEST_LEVEL`. It only forwards `classes → SFDT_TEST_CLASSES`. This must be fixed before the Coverage page's Run button will work.

---

### Task 1 — Forward `testLevel` in the generic command runner

**File:** `src/lib/gui-server/index.js`  
**Location:** `POST /api/command/run` handler, starting at line ~472

**Change:** Extract `testLevel` from `req.body`, validate it against `VALID_TEST_LEVELS`, and conditionally set `SFDT_TEST_LEVEL` in `scriptEnv` when `command === 'test'`.

```js
// After extracting `classes` at line ~474:
const { command, classes, testLevel } = req.body ?? {};

// After existing class validation (line ~486), add:
const VALID_TEST_LEVELS = ['RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg', 'NoTestRun'];
if (command === 'test' && testLevel !== undefined && !VALID_TEST_LEVELS.includes(testLevel)) {
  return res.status(400).json({ error: 'Invalid testLevel' });
}

// In the scriptEnv block (line ~514), after the SFDT_TEST_CLASSES conditional:
if (command === 'test' && testLevel) {
  scriptEnv.SFDT_TEST_LEVEL = testLevel;
}
```

**Tests:** `test/lib/gui-server-routes.test.js` — add cases verifying:
- `testLevel: 'RunLocalTests'` sets `SFDT_TEST_LEVEL` in the spawned env
- Unknown `testLevel` values return 400

---

### Task 2 — Add `RunLocalTests`/`RunAllTestsInOrg` branch in `enhanced-test-runner.sh`

**File:** `scripts/core/enhanced-test-runner.sh`

**Change:** At the top of the script, before the class-batching logic, inspect `SFDT_TEST_LEVEL`:

```bash
# At top of main logic (after env var setup):
if [[ "${SFDT_TEST_LEVEL}" == "RunLocalTests" || "${SFDT_TEST_LEVEL}" == "RunAllTestsInOrg" ]]; then
  RESULTS_DIR="${SFDT_PROJECT_ROOT}/logs/test-results"
  mkdir -p "$RESULTS_DIR"
  TIMESTAMP=$(date +%Y%m%d_%H%M%S)
  OUTPUT_FILE="${RESULTS_DIR}/local_${TIMESTAMP}.json"

  sf apex run test \
    --test-level "${SFDT_TEST_LEVEL}" \
    --code-coverage \
    --json \
    --wait 20 \
    --target-org "${SFDT_TARGET_ORG:-$SFDT_DEFAULT_ORG}" \
    > "$OUTPUT_FILE" 2>&1

  EXIT_CODE=$?

  # Emit the same compact summary line that parsers.js reads:
  jq -c '{
    summary: .result.summary,
    testRunCoverage: (.result.summary.testRunCoverage // null),
    classCoverage: (.result.codeCoverage // [])
  }' "$OUTPUT_FILE" || true

  exit $EXIT_CODE
fi
# ... existing class-batching path continues unchanged ...
```

The `parsers.js` `parseTestRunLines()` already reads `testRunCoverage` and `codeCoverage[]` from this shape — no parser changes needed.

**Tests:** Manual smoke test with a connected org; no unit tests for shell scripts.

---

### Task 3 — Add `POST /api/test/classes/sync` endpoint

**File:** `src/lib/gui-server/index.js`  
**Location:** After the existing `GET /api/test/classes` handler (line ~265)

**Change:** New route that discovers test classes and writes them back to config:

```js
app.post('/api/test/classes/sync', apiLimiter, async (_req, res) => {
  if (!requireCsrfToken(req, res, csrfToken)) return;
  try {
    const projectRoot = config._projectRoot ?? process.cwd();
    const sourcePath  = config.defaultSourcePath ?? 'force-app/main/default';
    const absSource   = path.join(projectRoot, sourcePath);
    const configPath  = path.join(projectRoot, '.sfdt', 'config.json');

    if (!(await fs.pathExists(absSource))) {
      return res.status(400).json({ error: `Source path not found: ${sourcePath}` });
    }

    const { glob } = await import('glob');
    const files = await glob('**/*.cls', { cwd: absSource, nodir: true });
    const discovered = files
      .map((f) => path.basename(f, '.cls'))
      .filter((name) => /(?:Test|Tests)$/i.test(name))
      .sort();

    if (discovered.length === 0) {
      return res.status(400).json({ error: 'No test classes found in source path' });
    }

    const existing = config.testConfig?.testClasses ?? [];
    const added    = discovered.filter((c) => !existing.includes(c)).length;
    const removed  = existing.filter((c) => !discovered.includes(c)).length;

    // Mutate config in memory and persist
    if (!config.testConfig) config.testConfig = {};
    config.testConfig.testClasses = discovered;
    const raw = await fs.readJson(configPath);
    if (!raw.testConfig) raw.testConfig = {};
    raw.testConfig.testClasses = discovered;
    await fs.writeJson(configPath, raw, { spaces: 2 });

    res.json({ added, removed, total: discovered.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

**Tests:** `test/lib/gui-server-routes.test.js` — add cases verifying:
- Returns `{ added, removed, total }` when classes are found
- Returns 400 when no classes found (does not write to config)
- Returns 400 when source path is missing

---

### Task 4 — Add `api.syncTestClasses()` to `gui/src/api.js`

**File:** `gui/src/api.js`  
**Location:** Near existing `testClasses` entry

**Change:**
```js
syncTestClasses: () => post('/test/classes/sync'),
```

where `post` is the existing CSRF-aware POST helper already used by other api methods.

---

### Task 5 — Create `gui/src/pages/Coverage.jsx`

**File:** New file  
**Imports needed:** `StatCard`, `CommandRunner` from components; `api` from `../api.js`; `useState`, `useEffect`, `useCallback` from React

**Structure — four zones as a vertical stack inside a scrollable page div:**

```
<div className="page coverage-page">
  <h1>Coverage</h1>

  {/* Zone 1: Run Panel */}
  <div className="card run-panel">
    <select value={testLevel} onChange={...}>
      <option value="RunLocalTests">Run Local Tests</option>
      <option value="RunAllTestsInOrg">Run All Tests in Org</option>
      <option value="RunSpecifiedTests">Run Specified Classes</option>
    </select>
    {testLevel === 'RunAllTestsInOrg' && <p className="warn-note">This may take 10+ minutes depending on org size</p>}
    <button onClick={handleRun} disabled={running}>
      {running ? 'Running…' : LABELS[testLevel]}
    </button>
    <button onClick={handleSync} disabled={syncing}>Sync from Source</button>
    {syncResult && <p className="inline-toast">{syncResult}</p>}
    {running && <CommandRunner ... />}
  </div>

  {/* Zone 2: Stat Cards */}
  <div className="stat-row">
    <StatCard label="Last Coverage" value={...} accent={coverageAccent(last)} />
    <StatCard label="Threshold"     value={`${threshold}%`} accent="neutral" />
    <StatCard label="Below Threshold" value={belowCount} accent={belowCount > 0 ? 'red' : 'green'} />
    <StatCard label="Last Run"      value={lastDate} accent="neutral" />
  </div>

  {/* Zone 3: Trend */}
  {runs.length < 2
    ? <p className="empty-hint">Run coverage a few times to see trends</p>
    : <div className="trend-list">{/* one row per run, last 10 */}</div>
  }

  {/* Zone 4: Per-Class Table */}
  <div className="class-table-section">
    <input placeholder="Filter by class name" value={filter} onChange={...} />
    <label><input type="checkbox" checked={belowOnly} onChange={...} /> Below threshold only</label>
    <table>...</table>
    {selectedClass && <FailingTestsModal ... onClose={() => setSelectedClass(null)} />}
  </div>
</div>
```

**State:**
```js
const [testLevel, setTestLevel]       = useState('RunLocalTests');
const [runs, setRuns]                 = useState([]);
const [selectedRun, setSelectedRun]   = useState(null);   // null = latest
const [filter, setFilter]             = useState('');
const [belowOnly, setBelowOnly]       = useState(false);
const [sortCol, setSortCol]           = useState('coverage');
const [sortDir, setSortDir]           = useState('asc');
const [running, setRunning]           = useState(false);
const [syncing, setSyncing]           = useState(false);
const [syncResult, setSyncResult]     = useState(null);
const [selectedClass, setSelectedClass] = useState(null);
```

**`handleRun`:** calls `api.commandRun('test', { testLevel })`, sets `running = true`, on SSE `result` event sets `running = false` and refreshes runs.

**`handleSync`:** calls `api.syncTestClasses()`, on success shows `"Added N · Removed N · Total N classes"` in `syncResult` for 4 seconds.

**`FailingTestsModal`:** inline component in same file — receives `{ run, className, threshold, onClose }`, renders failing tests from `run.tests`, AI button pre-fills chat context via `window.dispatchEvent(new CustomEvent('sfdt:chat', { detail: prompt }))` (matches existing ChatContext pattern).

**Data derivation:**
```js
const activeRun    = selectedRun ?? runs[0] ?? null;
const classCoverage = activeRun?.classCoverage ?? [];
const threshold    = config?.deployment?.coverageThreshold ?? 75;
const belowCount   = classCoverage.filter((c) => c.percent < threshold).length;
const filtered     = classCoverage
  .filter((c) => !belowOnly || c.percent < threshold)
  .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));
// sort filtered by sortCol / sortDir before rendering
```

**Accent helper:**
```js
const coverageAccent = (pct) =>
  pct == null ? 'neutral' : pct >= threshold ? 'green' : pct >= 60 ? 'yellow' : 'red';
```

---

### Task 6 — Add Coverage route and nav entry to `App.jsx`

**File:** `gui/src/App.jsx`

**Change 1 — import:**
```js
import Coverage from './pages/Coverage.jsx';
```

**Change 2 — route** (in `<Routes>`):
```jsx
<Route path="/coverage" element={<Coverage />} />
```

**Change 3 — sidebar nav entry** (in the nav list, after TestRuns entry):
```jsx
<NavLink to="/coverage">Coverage</NavLink>
```

---

### Task 7 — Build and smoke test

```bash
# From sfdt package root:
npm run build:gui

# Verify symlink:
ls -la $(which sfdt)

# Start against a project:
cd /path/to/sf-project && sfdt ui

# Smoke test sequence:
# 1. Navigate to Coverage page — confirm 4 zones render
# 2. Select "Run Local Tests", click Run — confirm SSE terminal streams
# 3. After run completes, confirm stat cards + trend row populated
# 4. Click a class row — confirm modal opens with test detail
# 5. Click "Sync from Source" — confirm inline toast shows counts
# 6. Select "Run All Tests in Org" — confirm warning note appears
```

---

### Implementation Order

| # | Task | File(s) | Effort |
|---|------|---------|--------|
| 1 | Forward `testLevel` in command runner | `gui-server/index.js` | 30 min |
| 2 | `RunLocalTests`/`RunAllTestsInOrg` branch | `enhanced-test-runner.sh` | 1 hr |
| 3 | `POST /api/test/classes/sync` endpoint | `gui-server/index.js` | 45 min |
| 4 | `api.syncTestClasses()` | `gui/src/api.js` | 5 min |
| 5 | `Coverage.jsx` page | `gui/src/pages/Coverage.jsx` | 3–4 hr |
| 6 | Route + nav in `App.jsx` | `gui/src/App.jsx` | 10 min |
| 7 | Build + smoke test | — | 30 min |

**Total estimate:** ~6–7 hours

Tasks 1, 3, and 4 are fully independent. Task 2 is independent. Task 5 depends on Task 4 (for `api.syncTestClasses`). Task 6 depends on Task 5 existing. Recommended order: 4 → 1 → 3 → 2 → 5 → 6 → 7.
