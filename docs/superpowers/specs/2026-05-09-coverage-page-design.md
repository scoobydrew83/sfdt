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
