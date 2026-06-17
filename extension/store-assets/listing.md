# Chrome Web Store Listing

> **Store-sync status:** Updated for **v0.2.0** (24 features). As of 2026-06-17 the
> *live* CWS listing still reflects the older **17-feature** copy — this file is ahead
> of the store. Paste the sections below into the CWS dashboard during the manual
> v0.2.0 upload, then this file and the store will be back in sync.
>
> Screenshots and the store icon live alongside this file in `extension/store-assets/`
> (`final_01`–`final_05` + `store-icon-128.png`). The screenshots predate the
> 0.1.0/0.2.0 features — adding shots for `export-for-prompt` and the other newer
> features is an optional follow-up.

## Item name
SFDT SF Helper

## Short description (max 132 chars)
Productivity tools for Salesforce admins & developers — Flow, Setup, Object Manager, record pages, SOQL/REST/SOAP & AI.

## Category
Developer Tools (alt: Workflow & Planning)

## Language
English (United States)

## Detailed description
SFDT SF Helper adds 24 productivity features for Salesforce admins and developers across Flow Builder, Setup, Object Manager, and record pages — spanning flow analysis, schema and data tooling, SOQL/REST/SOAP exploration, event monitoring, and optional AI assistance. Every feature is opt-in via the options page, and any feature can be remotely disabled without a Web Store re-review.

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
Reads the user's existing Salesforce session cookie on the Salesforce tab so the extension can authenticate Tooling API and REST calls to the user's own org. No cookies are ever sent off-origin.

### host_permissions: https://*.salesforce.com/*, https://*.salesforce-setup.com/*, https://*.my.salesforce.com/*, https://*.lightning.force.com/*
The extension only operates on Salesforce origins. Required to inject UI and call the Tooling/REST APIs of the user's logged-in org.

### host_permissions: http://localhost/*, http://127.0.0.1/*
Optional connection to the user's local sfdt CLI HTTP bridge (default port 7654) for Flow Deploy, Rollback, and AI Assistant features. Disabled until the user starts the bridge themselves.

## Distribution
- Visibility: Public
- Regions: All
- Pricing: Free
