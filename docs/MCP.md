# sfdt DevOps MCP Server

The `sfdt` Model Context Protocol (MCP) server exposes Salesforce release management, testing, and governance tools directly to agentic workflows (such as Claude Code, Cursor, Copilot, or standard MCP clients).

---

## Startup Command

To run the MCP server locally in stdio transport mode:

```bash
sfdt mcp start
```

This starts a JSON-RPC 2.0 stdio stream on standard input and output. All operational logs are routed to standard error (`stderr`) to keep the RPC channel clean.

---

## Config Options

Configure the MCP server in your `.sfdt/config.json` under the `mcp` key:

```json
{
  "mcp": {
    "enabled": true,
    "parking": {
      "enabled": true,
      "thresholdBytes": 50000,
      "ttlSeconds": 86400,
      "cacheScope": "session"
    }
  }
}
```

* **`mcp.enabled`:** Toggle MCP integration.
* **`mcp.parking.enabled`:** Enables context budget governance.
* **`mcp.parking.thresholdBytes`:** Size limit above which response payloads are parked (default: 50 KB).
* **`mcp.parking.ttlSeconds`:** Time-to-live before parked cache files are deleted (default: 24 hours). The `ttlMs` field in parked envelopes is derived from this value.
* **`mcp.parking.cacheScope`:** SEP-2549 cache scope advertised on parked envelopes — `"global"`, `"user"`, or `"session"` (default: `"session"`).

---

## Exposed Tools

### 1. Pre-Deployment Validation

#### `sfdt_preflight`
Runs standard pre-deployment validation checks (git state, branch naming, Apex quality checkpoints).
* **Arguments:**
  * `strict` (boolean, optional): Promote warnings to errors.

#### `sfdt_validate`
Performs a dry-run metadata deployment on Salesforce.
* **Arguments:**
  * `targetOrg` (string, required): Org alias.
  * `manifest` (string, optional): Path to package.xml manifest.
  * `testLevel` (enum, optional): `NoTestRun` | `RunSpecifiedTests` | `RunLocalTests` | `RunAllTestsInOrg`.
  * `testClasses` (array of strings, optional): Specific test classes to execute.

---

### 2. Deployment & Rollback (Safety Guarded)

> [!CAUTION]
> Dangerous and modifying operations require passing `confirmExecution: true` as an explicit safety gate. If omitted or set to false, the tool will return a validation error and abort execution.

#### `sfdt_deploy`
Performs a full metadata deployment to the target org.
* **Arguments:**
  * `targetOrg` (string, required): Org alias.
  * `manifest` (string, optional): Path to package.xml manifest.
  * `testLevel` (enum, optional): Test level.
  * `testClasses` (array of strings, optional): Apex test classes.
  * `destructiveTiming` (enum, optional): `pre` | `post` | `none` | `only`.
  * `confirmExecution` (boolean, required): Set to `true` to acknowledge authorization.

#### `sfdt_quick_deploy`
Promotes a previously validated metadata validation job.
* **Arguments:**
  * `validationJobId` (string, required): Salesforce job ID (`0Af...`).
  * `targetOrg` (string, required): Org alias.
  * `confirmExecution` (boolean, required): Set to `true` to acknowledge authorization.

#### `sfdt_rollback`
Rolls back the last successful deployment using state backups.
* **Arguments:**
  * `confirmExecution` (boolean, required): Set to `true` to acknowledge authorization.

---

### 3. Analysis & Observe

#### `sfdt_drift`
Runs metadata drift checks between local directories and the target org.
* **Arguments:**
  * `org` (string, optional): Target org.

#### `sfdt_compare`
Compares metadata between two orgs, or local source and an org.
* **Arguments:**
  * `source` (string, required): Source org or "local".
  * `target` (string, required): Target org alias.

#### `sfdt_quality`
Analyzes Apex code quality or generates mock test stubs.
* **Arguments:**
  * `generateStubs` (boolean, optional): Generate boilerplate `@IsTest` classes.
  * `fixPlan` (boolean, optional): Generate an AI-powered plan to fix coverage gaps.

#### `sfdt_logs`
Reads the latest deployment, preflight, quality, or drift logs.
* **Arguments:**
  * `type` (enum, required): `preflight` | `drift` | `deploy` | `rollback` | `quality`.

#### `sfdt_audit`
Runs native org-health diagnostics (audit trail, license usage, MFA coverage, unused Apex, inactive users, deprecated API versions) and returns the normalised snapshot.
* **Arguments:**
  * `check` (string, optional): A specific check id, or `all` (default) to run every check.
  * `org` (string, optional): Target org.

#### `sfdt_monitor`
Runs native org monitoring (limits, Apex job failures, Security Health Check score) and optionally a full metadata backup.
* **Arguments:**
  * `check` (string, optional): A specific check id, `all` (default), or `backup`.
  * `org` (string, optional): Target org.

#### `sfdt_docs`
Generates MkDocs-compatible documentation (custom objects + fields, Apex classes, Flows) with an optional AI project overview, or a Mermaid ER diagram.
* **Arguments:**
  * `action` (enum, optional): `generate` (default) | `diagram`.

---

### 4. Context Budget Governance & Parking

When a tool result exceeds `mcp.parking.thresholdBytes`, the server writes the full payload to `.sfdt/cache/parked/<uuid>.json` and returns a lightweight envelope instead:

```json
{
  "_parked": true,
  "ref": "parked://<uuid>",
  "byteSize": 123456,
  "rowCount": 42,
  "preview": "...",
  "ttlMs": 86400000,
  "cacheScope": "session"
}
```

> [!NOTE]
> **Breaking envelope change:** the `expiresAt` ISO timestamp field was replaced by `ttlMs` + `cacheScope` to match the SEP-2549 cache metadata shape in the MCP 2026-07-28 release candidate. Consumers should treat `ttlMs` as relative to when the envelope was received.

#### `sfdt_get_parked_result`
Retrieves the full content of an oversized payload cached under `.sfdt/cache/parked/`.
* **Arguments:**
  * `ref` (string, required): The reference URI (e.g. `parked://<uuid>`).

---

## MCP RC Alignment (2026-07-28)

The server is aligned with the MCP 2026-07-28 release candidate at the application level. The pinned SDK (`~1.29.0`) predates the RC, so protocol-level negotiation is unchanged; the items below are sfdt's own surface:

* **No deprecated primitives.** The server advertises a tools-only capability — `Roots`, `Sampling`, and `Logging` (deprecated in the RC with a 12-month removal runway) are not exposed and must not be added.
* **Stateless per-request design.** Every tool call shells out to the sfdt CLI; no session state exists beyond the parked-file cache, matching the RC's stateless posture (SEP-2567).
* **SEP-2549 cache metadata.** `tools/list` responses include `ttlMs: 86400000, cacheScope: "global"` (the catalog is static per process). Parked envelopes carry `ttlMs`/`cacheScope` instead of `expiresAt`. If a strict non-SDK client ever rejects the top-level fields on `tools/list`, relocating them into `_meta` is a one-line change.
* **W3C Trace Context (SEP-414).** `traceparent`/`tracestate` are read from `params._meta` on `tools/call`, validated, included in stderr audit logs for correlation, and echoed back in the result `_meta`.
* **Redacted audit logging.** Tool-call logs record the tool name, argument keys, payload size, and traceparent — never argument values.
* **Deferred until an RC-aware SDK ships:** consuming server-advertised `ttlMs` in `src/lib/mcp-client.js` (which currently uses a local 30s cache), and any Streamable HTTP transport (which would require `Mcp-Method`/`Mcp-Name` header enforcement plus an OAuth/OIDC story).

---

## Client Integration Examples

### Claude Code

Add this entry to your `~/.claudecode/config.json` or project-local configurations:

```json
{
  "mcpServers": {
    "sfdt": {
      "command": "node",
      "args": ["/absolute/path/to/sfdt/bin/sfdt.js", "mcp", "start"]
    }
  }
}
```

### Cursor

1. Open **Settings** -> **Features** -> **MCP**.
2. Click **+ Add New MCP Server**.
3. Set Name to `sfdt`.
4. Set Type to `stdio`.
5. Set Command to:
   ```bash
   node /absolute/path/to/sfdt/bin/sfdt.js mcp start
   ```
