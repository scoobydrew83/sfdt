# Design: MCP Parking Pattern + Skills-over-MCP Bundling

**Date:** 2026-05-07  
**Project:** @sfdt/cli  
**Status:** Approved — ready for implementation planning

---

## Overview

Two independent features that reduce token usage and improve AI guidance for sfdt's Salesforce MCP integration:

1. **MCP Parking Pattern** — park large MCP tool results in `.sfdt/cache/parked/` and return a reference key instead of inlining raw payloads into system prompts
2. **Skills-over-MCP Bundling** — add a `SKILL.md` that teaches Claude Code (and sfdt's own chat drawer) how to sequence and constrain Salesforce MCP tool calls

Both features touch `ai-context.js`. Both are additive — no breaking changes to existing callers.

---

## Feature 1: MCP Parking Pattern

### Motivation

`getDevOpsCenterContext()` returns raw JSON from Headless360 pipeline and work item tools. As sfdt adds more MCP tools (SOQL query, metadata retrieval), result payloads could easily exceed 50KB — bloating system prompts and triggering context compaction. The Parking Pattern decouples data size from prompt size.

### Architecture

All changes confined to `src/lib/mcp-client.js`. No new file.

#### Constants

```js
const PARK_THRESHOLD_BYTES = 50_000;  // 50KB
const PARK_TTL_MS = 60 * 60 * 1000;  // 1 hour
```

#### Private method: `#parkResult(data)`

- Derives park dir: `config._projectRoot + '/.sfdt/cache/parked/'`
- Generates filename via `crypto.randomUUID()`
- Writes `{ ts: Date.now(), data }` envelope to `.sfdt/cache/parked/<uuid>.json`
- Returns ref object: `{ _parked: true, ref: uuid, byteSize, preview }`
  - `preview`: first 3 entries if `data` is an array; first 3 keys if object

#### Hook in `#callMatchingTools()`

After assembling `results`:
```
serialized = JSON.stringify(results)
if serialized.length > PARK_THRESHOLD_BYTES → return #parkResult(results)
else → return results (unchanged)
```

#### Public method: `getParkedResult(ref)`

- Reads `.sfdt/cache/parked/<ref>.json`
- Returns `null` if file missing or `Date.now() - ts > PARK_TTL_MS`
- Returns `data` if valid

#### Lazy cleanup in `connect()`

On each `connect()` call, scan the park dir and delete files older than `PARK_TTL_MS`. Uses synchronous `readdirSync` — startup path only, not hot.

### `ai-context.js` change

Where MCP data is formatted into context sections, check for `_parked: true`:

- **Not parked:** inline current behavior unchanged
- **Parked:** emit:
  ```
  ## DEVOPS CENTER CONTEXT (parked — ref: <uuid>, <byteSize> bytes)
  Preview: <preview>
  (Call getParkedResult("<uuid>") to retrieve full data)
  ```

Full retrieval wiring in the chat endpoint is a follow-up — not in this PR.

### Error handling

- If park dir write fails: log warning, fall back to returning full data inline (never surface to user)
- `getParkedResult` returns `null` on any read error — callers must handle null

### Testing

- Unit test: `#callMatchingTools` with a result >50KB returns `{ _parked: true, ref, byteSize, preview }`
- Unit test: `#callMatchingTools` with a result <50KB returns full data unchanged
- Unit test: `getParkedResult` returns null for missing/expired refs
- Unit test: `getParkedResult` returns data for valid ref within TTL
- Unit test: `connect()` cleanup deletes files older than TTL, leaves fresh files

---

## Feature 2: Skills-over-MCP Bundling

### Motivation

`mcp-client.js` exposes `getPipelineStatus` and `getWorkItems` but gives the AI no guidance on sequencing or constraints. The chat drawer inlines raw results but doesn't explain how to act on them. A `SKILL.md` provides the missing behavioral layer — without adding runtime complexity.

### Architecture

#### New file: `.claude/skills/sfdt-salesforce-mcp/SKILL.md`

Frontmatter + four sections:

1. **Tool index** — what each tool returns and when to call it
2. **Sequencing rules** — pipeline status first; skip work items if pipeline is `Queued` or `Deploying`
3. **Constraints** — 30s cache TTL; graceful degradation when `mcp.enabled: false`; work item data is advisory only
4. **sfdt command integration** — pipeline ready → `sfdt deploy`; uncertain → `sfdt preflight`; failed tests → `sfdt test` before re-promoting

#### New function in `ai-context.js`: `readMcpSkill(projectRoot)`

- Reads `.claude/skills/sfdt-salesforce-mcp/SKILL.md`
- Strips YAML frontmatter (lines between opening and closing `---`)
- Returns body string, or `''` if file missing (graceful degradation — MCP skill is optional)

#### Integration in `ai-context.js`

`readMcpSkill()` result is passed as a section string alongside existing MCP data sections when callers (e.g. the chat endpoint in `gui-server.js`) assemble the array for `buildContextBlock()`. The AI receives both live DevOps Center data and sequencing guidance in the same system prompt.

#### PR checklist rule

Add to `.claude/skills/document/SKILL.md`: changes to `mcp-client.js` tool patterns (adding tools, changing tool names, updating `HEADLESS360_*_PATTERNS`) trigger a review of `.claude/skills/sfdt-salesforce-mcp/SKILL.md`.

### Error handling

- `readMcpSkill` catches all read errors silently — returns `''`
- Missing skill file is not an error condition

### Testing

- Unit test: `readMcpSkill` returns body string when file exists (frontmatter stripped)
- Unit test: `readMcpSkill` returns `''` when file missing
- Integration: chat system prompt includes skill section when MCP is enabled and skill file exists

---

## What is NOT in scope

- Full retrieval wiring from the chat endpoint (follow-up: `POST /api/mcp/parked/:ref`)
- Parking for future SOQL query tools (the infrastructure supports it — just add threshold check at call site)
- Dynamic skill generation from `listTools()` at runtime
- Parking for non-MCP AI results (the chat drawer's own AI responses)

---

## File change summary

| File | Change |
|------|--------|
| `src/lib/mcp-client.js` | Add `PARK_THRESHOLD_BYTES`, `PARK_TTL_MS`, `#parkResult()`, `getParkedResult()`, cleanup in `connect()`, threshold check in `#callMatchingTools()` |
| `src/lib/ai-context.js` | Add `readMcpSkill(projectRoot)`, format parked ref in MCP context section, include skill in `buildContextBlock()` |
| `.claude/skills/sfdt-salesforce-mcp/SKILL.md` | New file |
| `.claude/skills/document/SKILL.md` | Add rule: MCP tool changes → review sfdt-salesforce-mcp skill |
| `test/lib/mcp-client.test.js` | New/extended tests for parking and cleanup |
| `test/lib/ai-context.test.js` | New tests for `readMcpSkill`, parked formatting |
