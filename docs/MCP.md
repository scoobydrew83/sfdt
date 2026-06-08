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
      "ttlSeconds": 86400
    }
  }
}
```

* **`mcp.enabled`:** Toggle MCP integration.
* **`mcp.parking.enabled`:** Enables context budget governance.
* **`mcp.parking.thresholdBytes`:** Size limit above which response payloads are parked (default: 50 KB).
* **`mcp.parking.ttlSeconds`:** Time-to-live before parked cache files are deleted (default: 24 hours).

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

---

### 4. Context Budget Governance & Parking

#### `sfdt_get_parked_result`
Retrieves the full content of an oversized payload cached under `.sfdt/cache/parked/`.
* **Arguments:**
  * `ref` (string, required): The reference URI (e.g. `parked://<uuid>`).

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
