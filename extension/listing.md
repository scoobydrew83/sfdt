# Chrome Web Store Listing

> **Store-sync status:** Updated for **v0.8.0** (44 features). Since the last
> manual store upload (0.3.x era) this adds Apex tooling (Test Runner, Code
> Coverage, Trace Flags), a **Schema Browser**, **Dependency Explorer**, **API
> Version Audit**, in-browser **Flow Scanner**, **Org Health (Live)**, an **Org
> Release** badge, a **Command Palette**, a right-click record inspector, and the
> bridge tools **Org Compare / Drift Check / Metadata Scan**. As of the last
> manual upload the *live* CWS listing still reflects the older 29-feature copy —
> this file is ahead of the store. Paste the sections below into the CWS dashboard
> during the v0.8.0 upload, then this file and the store are back in sync.
>
> **Permission justifications must be pasted into the item's Privacy practices
> tab** (not just the description) — the store rejects auto-publish until every
> permission below has a justification saved. `contextMenus` + `sidePanel` were
> the two that blocked the v0.8.0 auto-publish.
>
> Screenshots, the store icon, and the small promo tile live alongside this file in
> `extension/store-assets/` (`store-icon-128.png`, `promo-small-440x280.png`, and
> `final_01`–`final_16`). The set was refreshed for 0.3.0: `final_01`–`final_05`
> (flow/setup era) plus `final_06`–`final_16` (Workspace tools + schema/data tooling).
> CWS shows up to 5 — featured set: `final_06`, `final_01`, `final_07`, `final_11`,
> and `final_18` (Org Limits). The Org Health screenshot is still pending (future
> `final_19`). See this folder's README for the full rationale and which shots to avoid.

## Item name
SFDT SF Helper

## Short description (max 132 chars)
Productivity tools for Salesforce admins & developers — Flow, Setup, Object Manager, record pages, SOQL/REST/SOAP & AI.

## Category
Developer Tools (alt: Workflow & Planning)

## Language
English (United States)

## Detailed description
SFDT SF Helper adds 44 productivity features for Salesforce admins and developers across Flow Builder, Setup, Object Manager, and record pages — now including a standalone Workspace tab that runs SOQL, Apex, and other tools in their own browser tab so they never disturb the Salesforce page you're on. Features span flow analysis, schema and dependency exploration, data tooling, SOQL/REST/SOAP exploration, anonymous Apex, Apex test running and coverage, debug-log/trace-flag and event monitoring, org health diagnostics, and optional AI assistance. Every feature is opt-in via the options page, and any feature can be remotely disabled without a Web Store re-review.

Features include:
- Setup Tabs — adds an Automation Home tab plus reorderable, groupable tabs to the Setup tab bar
- Search & Highlight — Cmd/Ctrl+Shift+F search across nodes on the Flow canvas
- Missing Description Flags — inline warnings on Flow nodes and fields without descriptions
- Flow Version Manager — side panel listing active/draft Flow versions with one-click activate or rollback
- API Name Generator — auto-generates API names from labels using configurable case style
- Scheduled Flow Explorer — list and calendar view of every scheduled Flow run in the org
- Flow Trigger Explorer Enhancer — adds bulk fetch and visual grouping to the native Trigger Explorer
- Flow List Search — fuzzy search over the Flow Definitions list
- Flow Health Check — scores the currently-open Flow against the @sfdt/flow-core rules engine
- Flow Deploy — deploy the current Flow via the local sfdt CLI bridge
- Comparison Exporter — export org-vs-org compare reports from the canvas
- AI Assistant — surface answers about the current Flow via Claude, Gemini, or OpenAI through the bridge
- SOQL Query Runner — run SOQL (REST or Tooling) with field/object autocomplete, query history, CSV export, and a LangGraph node generator
- Org Limits — current org limit utilization at a glance
- REST API Explorer — explore the REST API of the current org
- Subflow Caller Graph — visualize which Flows call the current Flow
- Trigger Conflicts — surface conflicting Flow Triggers on the same object
- Inspect Record — view a record's complete field set (including empty and system fields) via the REST API
- Data Import Wizard — guided CSV-based data import into the org
- Bulk Field Creator — create multiple custom fields at once
- Metadata Retrieve & Deploy — retrieve and deploy metadata directly from the browser
- SOAP API Explorer — build and send SOAP API requests with a payload editor and response viewer
- Event Streaming Monitor — subscribe to and monitor platform/streaming events live
- Export Schema for Prompt — copy a dense Markdown schema for an object to the clipboard for pasting into an LLM prompt (record pages and Object Manager)
- Execute Anonymous Apex — run anonymous Apex with a reusable snippet library
- Debug Logs — list ApexLog debug logs and view raw log bodies
- Saved SOQL — bookmark and re-run SOQL queries and history
- Switch Org — discover every org you're logged into and run any tool against it (multi-org)
- Org Health — view native sfdt audit and monitor snapshots (org limits, license usage, MFA coverage, security health score, Apex job failures, and more) in a side panel via the local CLI bridge
- Org Health (Live) — run org-health checks live against the org (Apex coverage, inactive users, licenses, API versions, limits) with no CLI snapshot needed
- Show API Names — toggle inline field API names and object/18-char-Id header on record pages; copy the record Id, an Apex insert, or SOQL for the current record
- Schema Browser — searchable two-pane explorer for the org's objects, fields, and relationships (Workspace or record page)
- Dependency Explorer — "what references this / what does this reference" across Apex, Flow, fields, pages, and LWC via MetadataComponentDependency
- Command Palette — keyboard-driven launcher to find and open any SFDT tool
- Apex Test Runner — run Apex tests asynchronously and view pass/fail results in the browser
- Apex Code Coverage — org-wide and per-class Apex coverage, worst-covered first, with the 75% deploy line flagged
- Trace Flags — create and manage TraceFlags/DebugLevels to control Apex debug logging
- API Version Audit — the org's max API version and release, with per-type API-version histograms that flag components below the supported floor
- Flow Scanner — score any Flow against the @sfdt/flow-core rules engine, run in-browser with no bridge required
- Org Release Badge — a Setup pill showing the org's Salesforce release and whether it's a preview instance
- Org Compare — diff two orgs' metadata and export the report (via the local CLI bridge)
- Drift Check — surface untracked metadata drift against a baseline (via the local CLI bridge)
- Metadata Scan — scan org metadata for issues (via the local CLI bridge)
- Right-click "Inspect this record" — optional context-menu shortcut that opens the record inspector from any Salesforce page or record link

Privacy
- No user data is sent to any third-party service.
- No analytics, telemetry, or usage tracking is sent off your device by default.
- No advertising, no ad networks, no tracking pixels.
- No accounts. No sign-up. No PII collected.
- All network traffic is to your Salesforce org (same origin you're already authenticated to), or to localhost when you've started the sfdt CLI yourself.

Full source code: https://github.com/scoobydrew83/sfdt
Privacy policy: https://github.com/scoobydrew83/sfdt/blob/main/extension/PRIVACY.md

## Single purpose
Enhance Salesforce for admins and developers with opt-in productivity features across Flow Builder, Setup, Object Manager, and record pages — including flow analysis, schema and data tooling, SOQL/REST/SOAP exploration, deploy/rollback via a local CLI bridge, and optional AI assistance.

## Permission justifications

### storage
Saves user preferences and per-feature toggle settings to chrome.storage.local so the user can disable individual features and configure the optional local-CLI bridge connection.

### clipboardWrite
Lets the user one-click copy generated API names, compare-report data, SOQL results, the SOQL-derived LangGraph node, and the object schema produced by Export Schema for Prompt to the clipboard.

### cookies
Reads the user's existing Salesforce session cookies so the extension can authenticate Tooling API and REST calls to the user's own org(s). The Switch Org / Workspace multi-org feature reads Salesforce session cookies to list the orgs you're already logged into and target tools at the one you pick. No cookies are ever sent off-origin.

### contextMenus
Adds an optional right-click "SFDT: Inspect this record" item on the user's Salesforce pages that opens the record inspector for the record Id in the page URL or a right-clicked record link. The menu only reads the URL to locate a record Id — it reads no cookies or session data — and it appears only on Salesforce hosts. It can be turned off from Options → Features.

### sidePanel
Lets the user dock the extension's own tool panel beside the Salesforce page (a "Workspace-in-a-dock"), opened from the toolbar popup's "Open side panel" button. It reads no new data and requests no additional host access — the panel resolves the org session the same way the Workspace tab does. Chrome only; on Firefox the same panel opens through the browser's native sidebar with no extra permission.

### host_permissions: https://*.salesforce.com/*, https://*.salesforce-setup.com/*, https://*.my.salesforce.com/*, https://*.lightning.force.com/*
The extension only operates on Salesforce origins. Required to inject UI and call the Tooling/REST APIs of the user's logged-in org.

### host_permissions: https://*.my.salesforce.mil/*, https://*.lightning.force.mil/*, https://*.sfcrmapps.cn/*, https://*.mcas.ms/*
Extends the same Salesforce-only support to orgs served on non-standard domains: US Government Cloud (GovCloud, `.mil`), Salesforce China (`.sfcrmapps.cn`), and orgs fronted by a Microsoft Defender for Cloud Apps reverse proxy (`.mcas.ms`). Used only to resolve and call the user's own org session on those domains; no data leaves the device.

### host_permissions: http://localhost/*, http://127.0.0.1/*
Optional connection to the user's local sfdt CLI HTTP bridge (default port 7654) for Flow Deploy, Rollback, and AI Assistant features. Disabled until the user starts the bridge themselves.

## Distribution
- Visibility: Public
- Regions: All
- Pricing: Free
