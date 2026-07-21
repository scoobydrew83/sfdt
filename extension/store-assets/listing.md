# Chrome Web Store Listing

> **Store-sync status:** Updated for **v0.3.2** (29 features). The 0.3.x line adds
> a standalone **Workspace** tab plus five new tools — Execute Anonymous Apex,
> Debug Logs, Saved SOQL, Switch Org (multi-org), and **Org Health** (audit/monitor
> snapshots via the local CLI bridge). As of the last manual upload the *live* CWS
> listing still reflects the older **17-feature** copy — this file is ahead of the
> store. Paste the sections below into the CWS dashboard during the manual v0.3.2
> upload, then this file and the store will be back in sync.
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
SFDT SF Helper adds 29 productivity features for Salesforce admins and developers across Flow Builder, Setup, Object Manager, and record pages — now including a standalone Workspace tab that runs SOQL, Apex, and other tools in their own browser tab so they never disturb the Salesforce page you're on. Features span flow analysis, schema and data tooling, SOQL/REST/SOAP exploration, anonymous Apex, debug-log and event monitoring, org health diagnostics, and optional AI assistance. Every feature is opt-in via the options page, and any feature can be remotely disabled without a Web Store re-review.

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
