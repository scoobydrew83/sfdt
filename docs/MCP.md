# sfdt DevOps MCP Server

The `sfdt` Model Context Protocol (MCP) server exposes Salesforce release management, testing, and governance tools directly to agentic workflows (such as Claude Code, Cursor, Copilot, or standard MCP clients).

---

## Startup Command

To run the MCP server locally in stdio transport mode:

```bash
sfdt mcp start
```

This starts a JSON-RPC 2.0 stdio stream on standard input and output. All operational logs are routed to standard error (`stderr`) to keep the RPC channel clean.

### Project routing

The server supports both project-bound and multi-project clients:

- When started inside an initialized Salesforce DX project, calls may omit `projectRoot`; SFDT uses the project containing both `sfdx-project.json` and `.sfdt/`.
- When started outside a project, the server remains available for tool discovery and each tool call must provide `projectRoot`.
- A call may always provide `projectRoot` to override the startup project. SFDT validates that path through the normal config loader before executing anything.

`projectRoot` is available on every tool schema:

```json
{
  "projectRoot": "/absolute/path/to/initialized-salesforce-project"
}
```

Configuration is isolated per request, so concurrent calls can safely target different projects. The project must already contain `sfdx-project.json` and a valid `.sfdt/` configuration; otherwise the call returns an error before invoking a command. This routes the local project only—it does not authorize or implicitly select a Salesforce org.

### Pinning which projects a server will serve

`projectRoot` is chosen by the **model**, and SFDT's AI surfaces feed that model
untrusted org content — Apex compile errors, flow metadata, deploy failure text. So a
call an operator reads as *"query the current project"* can name a **different checkout**
and run against that project's authenticated org, and the tool list will still present it
as read-only.

Cross-project routing is deliberate — it is what lets one server serve several checkouts —
so SFDT does not refuse it by default. On a machine holding more than one customer's
checkout, pin the server:

```bash
export SFDT_MCP_PROJECT_ROOTS="/work/customer-a:/work/customer-b"
```

Colon-separated absolute paths (`path.delimiter`). When set, a `projectRoot` outside the
list is refused before any command runs. **Unset — the default — nothing changes.**

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

> [!IMPORTANT]
> **`confirmExecution` is not the control for path arguments.** It authorises the
> *operation*, while the model still supplies the *argument* — so since 0.23.1 every
> path-shaped argument is contained independently of it:
>
> - `file` (`sfdt_apex_run`) and `manifest` (`sfdt_validate`, `sfdt_deploy`) must be
>   relative paths that resolve **inside** the project. Absolute paths and `..` segments
>   are rejected.
> - `set` (`sfdt_data_export` / `_import` / `_load` / `_delete`) must be a bare
>   identifier matching `^[A-Za-z0-9][A-Za-z0-9_-]*$` — no dots, slashes, or leading `-`.
>
> A rejected argument returns an error and the tool does not run. This is deliberate: MCP
> arguments are chosen by a model, and this CLI's AI surfaces feed that model untrusted
> org content (Apex compile errors, flow metadata, deploy failure text), so a path
> argument is untrusted input. See `src/lib/safe-path.js`.

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
  * `apexGuru` (boolean, optional): Run only the ApexGuru org-side analysis check. License/edition-gated — degrades to `skipped`/`warn`, never an error; returns `logs/apexguru-latest.json`.
  * `org` (string, optional): Target org alias for the ApexGuru check (default: the configured `defaultOrg`).

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

#### `sfdt_coverage`
Reports Apex code coverage for an org — org-wide percentage plus per-class coverage. Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_scan`
Fetches the complete metadata inventory of an org (all component types and members). Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_dependencies`
Shows a component's metadata dependencies — what it references and what references it. Read-only.
* **Arguments:**
  * `name` (string, **required**): component name (e.g. an Apex class or field API name).
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_field_impact`
Shows what **writes** a field — flows (parsed, not merely referencing it), workflow field updates, and an Apex text search — plus, separately, everything that merely references it. Read-only.
* **Arguments:**
  * `field` (string, **required**): qualified field, e.g. `Account.Region__c`.
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.
  * `links` (boolean, optional): resolve the org instance URL so rows carry Setup deep links (one extra call).

Every row in `rows` is `confirmed` (the metadata itself states the write) or `inferred` (a lead only — an Apex text hit may read the field, mention it in a comment, or merely share a name).

`references` is a SEPARATE list of components that mention the field **without writing it** — validation rules, layouts, reports, email templates, list views. Do not merge it into `rows`: "what writes this field" and "where does this field appear" are different questions, and a validation rule reported as a writer answers the wrong one. The result's `notes` say what was **not** scanned: which caps bound the scan, which queries were refused, and the Flow constructs the parser does not model. Those notes also travel in the envelope's `warnings`.

An empty `rows` array means *no writer was found by three bounded scans* — never that none exists. A caller that reports it as "nothing writes this field" is overstating the result.

#### `sfdt_field_usage`
Sweeps **every** field on an object for references — the cleanup-candidate view. Read-only.
* **Arguments:**
  * `object` (string, **required**): sObject API name.
  * `offline` (boolean, optional): scan the local repository instead of an org — no org needed. Results are always inferred, and no field is ever reported as safe to remove.
  * `population` (boolean, optional): count non-null values per unreferenced field.
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

Fields come back in three states: `unreferenced: true`, `false`, and **`null` — not scanned**. A standard field has no `CustomField` record for a dependency edge to point at, and a failed batch leaves its fields `null` too. Never report `null` as unreferenced.

`safeToRemove` is `null` unless `population: true` was passed, and is `true` only when the field is custom, scanned, unreferenced, measured at zero values, and neither required nor unique. Anything short of that carries a `keepReason` naming the condition it failed — including `population not measured`, which is what a metadata-only answer always is.

#### `sfdt_events_list`
Lists every subscribable streaming channel — custom and standard platform events, custom channels, and CDC entities — with each channel's Bayeux path. Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_events_tail`
Subscribes to a channel and collects events. **Always bounded** — returns after `timeoutSeconds`, or earlier once `max` events arrive or `expect` matches. Read-only.
* **Arguments:**
  * `channel` (string, **required**): channel name or full Bayeux path.
  * `replay` (string, optional): `"new"` (default), `"all"` for the retention window, or a replay id.
  * `timeoutSeconds` (number, optional): default 60.
  * `max` (number, optional): stop after this many events.
  * `expect` (object, optional): field → value; stops on the first match.
  * `org` (string, optional): org alias.

`replay: "all"` replays events already in the retention window (roughly 24h), which is how to inspect something that has already happened rather than waiting for it to recur. When `expect` is set, check `matched` — `false` means the event never arrived, which is usually the finding, not an error.

#### `sfdt_events_publish`
Publishes one platform event. **Mutating — requires `confirmExecution`.**
* **Arguments:**
  * `event` (string, **required**): platform event API name, ending in `__e`.
  * `fields` (object, **required**): field API name → value.
  * `org` (string, optional): org alias.
  * `dryRun` (boolean, optional): return the request body without sending it.
  * `confirmExecution` (boolean, **required**): must be true to publish.

This fires **real subscribers** — flows, triggers, and any external system listening on the channel. CDC events cannot be published; they are produced by Salesforce.

#### `sfdt_automation_list`
Lists every automation component and whether it is on — flows (including Process Builder), validation rules, duplicate rules, workflow rules and Apex triggers. Read-only.
* **Arguments:** `type` (optional), `org` (optional).

Each row carries `writeMode`. The five types are **not** written the same way: `tooling-metadata` is a record write; `metadata-deploy` (workflow rules, Apex triggers) is a retrieve-edit-deploy, and in production an Apex trigger's Status change *is* a code deployment that runs tests. Do not present them as equivalent toggles.

#### `sfdt_automation_set`
Turns one automation component on or off. **Mutating — requires `confirmExecution`.**
* **Arguments:** `type`, `name` (both **required**), `enable` (**required**), `org`, `dryRun`, `production`, `confirmExecution` (**required**).

This changes how the org behaves for **every user, immediately**. The prior state is recorded, so `sfdt_ledger_undo` reverses it. Production is refused unless `production: true`; detection fails safe, so an org whose sandbox status cannot be read is treated as production.

#### `sfdt_permissions_grant`
Grants or removes field access for a **permission set**. **Mutating — requires `confirmExecution`.**
* **Arguments:** `parent`, `fields`, `level` (all **required**), `org`, `dryRun`, `production`, `confirmExecution` (**required**).

Profiles are refused: Salesforce does not permit direct updates to profile-owned permission entries. Use `level: "none"` to remove access.

#### `sfdt_permissions_fix`
Applies the grants the **repository** declares but the org is missing, for one object. **Mutating — requires `confirmExecution`.**
* **Arguments:** `object` (**required**), `org`, `dryRun`, `production`, `confirmExecution` (**required**).

Only `missing-in-org` grants are applied. Grants the org has that source does not are left alone — removing access nobody asked to remove is a different decision, and a riskier one. Do not describe this as "syncing permissions"; it is one-directional by design.

#### `sfdt_ledger_list`
Lists recorded org changes, newest first, with the state each replaced. Read-only.
* **Arguments:** `limit` (optional).

`status` is derived: `applied`, `failed`, `undone`, or **`pending`** — pending means the change was recorded but its outcome never was, so the command may have been interrupted mid-write and the org should be checked before anything is undone.

#### `sfdt_ledger_undo`
Reverses a recorded change, restoring the state it replaced. **Mutating — requires `confirmExecution`.**
* **Arguments:** `id` (**required**), `confirmExecution` (**required**).

Appends a compensating entry rather than editing history. A second undo of the same change is refused, as is one recorded as failed.

#### `sfdt_permissions_matrix`
Shows what each profile and permission set **grants** on one object — object-level CRUD plus per-field read/edit. Read-only.
* **Arguments:**
  * `object` (string, **required**): sObject API name.
  * `user` (string, optional): username; narrows to that user's profile, permission sets and permission set groups. Requires an org.
  * `offline` (boolean, optional): read from the repository instead of an org. Cannot be combined with `user` — assignments are not in source.
  * `org` (string, optional): org alias.

**Never describe this result as "effective", "actual" or "final" access.** Muting permission sets subtract access inside a permission set group and are Metadata-API only, so they cannot be queried and a user's real access may be **less** than shown. Every response carries that caveat in `notes`; pass it on rather than dropping it.

An empty result is not "nobody has access" — Salesforce stores a permission entry only where access differs from the default.

#### `sfdt_permissions_drift`
Compares what the org grants on an object against what the repository declares. Read-only.
* **Arguments:**
  * `object` (string, **required**): sObject API name.
  * `org` (string, optional): org alias.

Verdicts: `extra-in-org` (granted in the org but absent from source — the one a security review cares about), `missing-in-org`, `changed`, and `only-in-org` / `only-in-repo` for a parent present on one side. Parents are matched by label, since the org knows them by id and the repo by filename.

#### `sfdt_packages_list`
Lists every package installed in the org, with its version and any annotation recorded in `.sfdt/packages.json`. Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

**Do not report `updateStatus` as though an API was checked.** Salesforce exposes no API for the latest available version of a managed package — AppExchange has no public API, and `SubscriberPackageVersion` is queryable only in a Dev Hub for packages you own. `update-available` means the installed version is behind one a **human recorded**; `unknown` means nothing was recorded to compare against, which is *not* "up to date"; `ahead-of-record` means the note is stale, not the org.

#### `sfdt_packages_compare`
Compares installed package versions between two orgs — the one update question that is fully answerable, since both are already authenticated. Read-only.
* **Arguments:**
  * `source` (string, **required**): source org alias.
  * `target` (string, optional): target org alias; defaults to `config.defaultOrg`.

Verdicts: `same`, `source-ahead`, `target-ahead`, `only-in-source`, `only-in-target`, and `unknown` — installed in both but a version could not be read. `unknown` is **not** the same as matching.

#### `sfdt_packages_note`
Records the vendor URL, the latest confirmed version, and the internal owner for one package. **Mutating — requires `confirmExecution`.**
* **Arguments:**
  * `namespace` (string, **required**): namespace prefix, or the name for an unmanaged package.
  * `url`, `latest`, `owner`, `notes` (strings, optional).
  * `confirmExecution` (boolean, **required**).

Writes `.sfdt/packages.json`, a **committed repo file**, so the annotation is shared and code-reviewed rather than trapped on one machine. Merges additively — fields not supplied are left alone, including keys written by a newer sfdt. `latest` must parse as a version or the write is refused.

#### `sfdt_flow_scan`
Analyzes a Salesforce org's Flows for quality issues and anti-patterns (via `@sfdt/flow-core`) — lists FlowDefinitions and fetches each active version from the org, then runs the health checks. Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_history`
Shows recent sfdt run history (audit/monitor/quality/test/deploy/agent-test) from the local SQLite run index — trend outcomes over time. Read-only.
* **Arguments:**
  * `type` (string, optional): filter to one run type.
  * `limit` (number, optional): max rows (default 30).

#### `sfdt_soql_search`
Finds sObjects in the org by name substring (schema search). Read-only.
* **Arguments:**
  * `term` (string, optional): case-insensitive substring matched against API names (omit for all).
  * `category` (enum, optional): `all` | `custom` | `standard` (default `all`).
  * `limit` (number, optional): max matches (default 100).
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.

#### `sfdt_soql_describe`
Describes an sObject — fields (type, picklists, references), key prefix, child relationships. Read-only.
* **Arguments:**
  * `sobject` (string, **required**): sObject API name.
  * `filter` (string, optional): only fields whose name/label contains this substring.
  * `tooling` (boolean, optional): describe a Tooling API object.
  * `org` (string, optional): org alias.

#### `sfdt_soql_validate`
Validates a SOQL query without executing it — local static checks plus an org `LIMIT 0` round-trip (degrades to local-only when the org is unreachable). Read-only.
* **Arguments:**
  * `query` (string, **required**): the SOQL query.
  * `org` (string, optional): org alias.

#### `sfdt_soql_plan`
Fetches the org's query plans for a SOQL query (REST explain endpoint — the query is never executed). Read-only.
* **Arguments:**
  * `query` (string, **required**): the SOQL query.
  * `org` (string, optional): org alias.

#### `sfdt_soql_query`
Executes a SOQL SELECT with a row bound enforced (`soql.defaultLimit`/`soql.maxLimit` — never unbounded); returns records plus truncation metadata. Read-only.
* **Arguments:**
  * `query` (string, **required**): the SOQL SELECT.
  * `limit` (number, optional): row bound (clamped to `soql.maxLimit`).
  * `tooling` (boolean, optional): query the Tooling API.
  * `org` (string, optional): org alias.

#### `sfdt_test`
Runs Apex tests via the enhanced test runner, optionally limited to specific classes. Consumes org test resources; not metadata-mutating.
* **Arguments:**
  * `classNames` (string[], optional): only run these Apex test classes.

#### `sfdt_data_export`
Exports a configured data set from the org to local files. Read-only with respect to the org.
* **Arguments:**
  * `set` (string, **required**): data set name.
  * `org` (string, optional): org alias.

#### `sfdt_apex_logs`
Lists recent Apex debug logs, or retrieves one log body by Id. Read-only.
* **Arguments:**
  * `org` (string, optional): org alias; defaults to `config.defaultOrg`.
  * `logId` (string, optional): retrieve this log's body instead of listing.
  * `limit` (number, optional): max logs to list (default 20).

---

### 4. Release, Scratch Orgs & Data (Safety Guarded)

These mutate the repo or org and require `confirmExecution: true` (except the read-only `status`/`export` paths).

#### `sfdt_release`
Builds a release (manifest + release notes). **Requires `confirmExecution`.**
* **Arguments:** `version`, `package`, `name`, `confirmExecution` (**required**).

#### `sfdt_scratch_create`
Creates a scratch org. **Requires `confirmExecution`.**
* **Arguments:** `alias`, `days`, `confirmExecution` (**required**).

#### `sfdt_scratch_delete`
Deletes a scratch org by alias/username. **Requires `confirmExecution`.**
* **Arguments:** `target` (**required**), `confirmExecution` (**required**).

#### `sfdt_scratch_pool`
Inspects (`status`, read-only) or tops up (`fill`, requires `confirmExecution`) the scratch-org pool.
* **Arguments:** `action` (`status` | `fill`, **required**), `size`, `confirmExecution` (required for `fill`).

#### `sfdt_record_get`
Reads one record and reports which fields are editable, and why the rest are not. Read-only.
* **Arguments:** `id` (**required**), `sobject`, `org`.

#### `sfdt_record_edit`
Updates fields on one record. Non-editable and unknown fields are refused locally, with the reason, before anything is sent. **Requires `confirmExecution`.**
* **Arguments:** `id` (**required**), `fields` (**required**, object of API name → value), `sobject`, `org`, `dryRun`, `confirmExecution` (**required**).

#### `sfdt_record_clone`
Creates a copy of a record from its createable fields, with optional overrides. **Requires `confirmExecution`.**
* **Arguments:** `id` (**required**), `fields`, `sobject`, `org`, `dryRun`, `confirmExecution` (**required**).

#### `sfdt_data_import`
Imports a data set into the org. **Requires `confirmExecution`.**
* **Arguments:** `set` (**required**), `org`, `confirmExecution` (**required**).

#### `sfdt_data_load`
Loads a bulk data set (`bulk.json`) into the org over Bulk API v2 — insert, or upsert by external id. **Requires `confirmExecution`.**
* **Arguments:** `set` (**required**, must be a bulk data set), `org`, `wait` (minutes), `async`, `confirmExecution` (**required**).

#### `sfdt_data_delete`
Bulk-deletes a data set in the org. Destructive — **requires `confirmExecution`.**
* **Arguments:** `set` (**required**), `org`, `confirmExecution` (**required**).

#### `sfdt_apex_trace`
Manages Apex debug trace flags. `list` is read-only; `start`/`stop` write `TraceFlag` records and **require `confirmExecution`.**
* **Arguments:** `action` (`start` | `stop` | `list`, **required**), `org`, `user`, `duration` (minutes, start only), `debugLevel` (start only), `all` (stop only), `confirmExecution` (required for `start`/`stop`).

#### `sfdt_apex_run`
Executes Anonymous Apex in the org from a project file or inline code. **Requires `confirmExecution`.**
* **Arguments:** `org`, `file` (project-relative path) or `apexCode` (inline), `confirmExecution` (**required**).

---

### 5. Context Budget Governance & Parking

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
