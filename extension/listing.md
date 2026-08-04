# Chrome Web Store Listing

> **Store-sync status:** Updated for **v0.12.0** (44 features — the count is read from
> `generated/chrome-features.json`, never counted by hand; re-derive it each release
> instead of incrementing it). Since the last manual store upload (0.3.x era) this adds
> Apex tooling (Test Runner, Code Coverage, Trace Flags), a **Schema Browser**, **Field
> Impact Analysis**, **Dependency Explorer**, **API Version Audit**, in-browser **Flow
> Scanner**, an **Org Release** badge, a **Command Palette**, a
> docked **side panel**, **SOSL** mode in the SOQL Runner, and a right-click record
> inspector, plus the bridge tools **Org Compare / Drift Check / Metadata Scan**. 0.12.0
> adds the **Workspace Overview** home (org-health tiles, quick actions, recent activity),
> a line-numbered **syntax-highlighting editor** for SOQL and Apex, and a rebuilt design
> system across every surface. As of the last manual upload the *live* CWS listing still
> reflects the older 29-feature copy — this file is ahead of the store. Paste the sections
> below into the CWS dashboard during the v0.12.0 upload, then this file and the store are
> back in sync.
>
> **The item name changed in 0.11.0.** The packaged manifest now reads "SFDT for
> Salesforce"; it was "SFDT SF Helper". The store's *item title* is a dashboard field
> rather than a manifest field, so it has to be renamed by hand in CWS during the same
> upload or the store keeps showing the old name.
>
> **Permission justifications must be pasted into the item's Privacy practices
> tab** (not just the description) — the store rejects auto-publish until every
> permission below has a justification saved. `contextMenus` + `sidePanel` were
> the two that blocked the v0.8.0 auto-publish. The permission set is **unchanged in
> 0.11.0** — `storage`, `clipboardWrite`, `cookies`, `contextMenus`, `sidePanel` plus the
> ten host permissions, verified against the built `.output/chrome-mv3/manifest.json`.
>
> Screenshots, the store icon, and the small promo tile live alongside this file in
> `extension/store-assets/` (`store-icon-128.png`, `promo-small-440x280.png`, and the
> `final_*` shots). **The screenshot set is 0.3.x-era and has not been recaptured since.**
> `final_14` and `final_15` were deleted pending recapture (one showed a live API-version
> error, the other leaked a real org id and email), and nothing that shipped after 0.3.x
> has a shot at all — no Schema Browser, Command Palette, Trace Flags, Field Impact
> Analysis, side panel, or SOSL mode. `final_06`, the hero shot, shows a Workspace nav
> from when there were 13 tools. Recapturing is a human task; see this folder's README for
> the featured-5 rationale and which shots to avoid.

## Dashboard field map

Everything below is ready to paste. This table says **which dashboard tab each field lives in**,
so the whole listing can be staged before the `ext-v0.11.0` zip is uploaded. Lengths were
measured from this file's own sections — the headroom column is what's left before the store
truncates or rejects.

| Field | CWS tab | Chars | Limit | Source |
|---|---|---|---|---|
| Item name | Store listing | 19 | 75 | **dashboard only — not the manifest** |
| Short description | Store listing | 119 | 132 | matches manifest `description` byte-for-byte |
| Category / Language | Store listing | — | — | dashboard only |
| Detailed description | Store listing | 5,987 | 16,000 | this file |
| Screenshots (5) | Store listing | — | 1280×800 | `store-assets/` |
| Single purpose | Privacy practices | 287 | 1,000 | this file |
| Permission justifications (8) | Privacy practices | ≤403 each | 1,000 each | this file |
| Data usage + certifications | Privacy practices | — | — | see below |
| Visibility / Regions / Pricing | Distribution | — | — | dashboard only |

**Four fields never come from the zip** and are the ones that silently keep showing stale values:
the item name, the category, the data-usage disclosures, and the distribution settings.

The **item name is the live one this release** — the packaged manifest reads "SFDT for
Salesforce" but the store will keep displaying "SFDT SF Helper" until it is retyped here by hand.

## Item name
SFDT for Salesforce

## Short description (max 132 chars)
Productivity tools for Salesforce admins & developers — Flow, Setup, Object Manager, record pages, SOQL/REST/SOAP & AI.

## Category
Developer Tools (alt: Workflow & Planning)

## Language
English (United States)

## Detailed description
SFDT for Salesforce adds 45 productivity features for Salesforce admins and developers across Flow Builder, Setup, Object Manager, and record pages — now including a standalone Workspace tab that runs SOQL, Apex, and other tools in their own browser tab so they never disturb the Salesforce page you're on. Features span flow analysis, schema and dependency exploration, data tooling, SOQL/REST/SOAP exploration, anonymous Apex, Apex test running and coverage, debug-log/trace-flag and event monitoring, org health diagnostics, and optional AI assistance. Every feature is opt-in via the options page, and any feature can be remotely disabled without a Web Store re-review.

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
- SOQL Query Runner — run SOQL (REST or Tooling) or SOSL text searches with field/object autocomplete, query history and bookmarks, CSV export, query plans, and a LangGraph node generator; SOSL results are grouped per object with per-object copy and export
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
- Org Health — five checks (Apex coverage, inactive users, licenses, API versions, limits) run live against the org with no setup, plus twelve more (MFA coverage, security health score, Apex job failures, and more) from native sfdt audit and monitor snapshots when the local CLI bridge is running
- Show API Names — toggle inline field API names and object/18-char-Id header on record pages; copy the record Id, an Apex insert, or SOQL for the current record
- Schema Browser — searchable two-pane explorer for the org's objects, fields, and relationships (Workspace or record page)
- Field Impact Analysis — "what writes this field?": the Flows (parsed, not guessed), workflow field updates, and Apex classes/triggers that write a given field, each labelled confirmed or inferred, with open links
- Dependency Explorer — "what references this / what does this reference" across Apex, Flow, fields, pages, and LWC via MetadataComponentDependency
- Command Palette — keyboard-driven launcher to find and open any SFDT tool
- Apex Test Runner — run Apex tests asynchronously and view pass/fail results in the browser
- Apex Code Coverage — org-wide and per-class Apex coverage, worst-covered first, with the 75% deploy line flagged
- Trace Flags — create and manage TraceFlags/DebugLevels to control Apex debug logging
- API Version Audit — the org's max API version and release, with per-type API-version histograms (Apex classes/triggers, Flows, LWC, Aura) that flag components below the supported floor and expand to name exactly which ones are behind
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

## Privacy practices — data usage & certifications

The **Privacy practices** tab is what actually blocks auto-publish, and none of it comes from
the zip. Alongside the Single purpose and the eight permission justifications above, the tab
asks for the following. Answers verified against the built manifest and the code on this ref,
not from memory:

### Are you using remote code?
**No — all code is bundled in the package.** Verified: the built manifest declares no
`content_security_policy`, no `sandbox`, no `web_accessible_resources` and no
`externally_connectable`, and there is no `<script src="http…">`, no `import()` of a URL, and
no `eval`/`new Function` anywhere in `entrypoints/`, `features/`, `ui/` or `lib/`.

### Data usage — what the item collects
Chrome's definition of *collect* is transmitting data **off the user's device to a server you
or a third party control**. On that definition the answer is **none of the listed categories**:

| Category | Answer |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | No |

All Salesforce traffic goes to **the user's own org** — the same origin they are already
authenticated to — or to **localhost** when they have started the sfdt CLI themselves. Session
cookies are read locally to resolve the org session and never leave the device
(`test/sid-never-leaves-worker.test.ts` enforces this with zero allowlisted exceptions).
Telemetry is off by default, local-only, and has no network egress (`test/telemetry.test.ts`,
11/11 passing on this ref).

> **One answer needs your call before you save the tab — the AI Assistant.** When a user
> explicitly enables it, Flow content is sent to Claude / Gemini / OpenAI **through the local
> CLI bridge, using an API key the user supplies and is billed for**. `PRIVACY.md`'s "Third
> parties" section states the position: the extension is a pass-through and we neither see,
> log, nor store prompts or completions. Because the developer operates no server and the
> destination is the user's own provider account, "No" to *Website content* is defensible and
> is the answer this file records. The opposing reading is that content does leave the device
> to a third party, opt-in or not. It is a disclosure decision rather than a technical one, so
> confirm it rather than pasting it unread — an under-disclosure here is the kind of thing
> that gets an item pulled after the fact, not rejected at review.

### The three certification checkboxes
All three are truthful for this item and must be ticked or the submission will not save:

- [ ] Data is not being sold to third parties, outside of approved use cases
- [ ] Data is not being used or transferred for purposes unrelated to the item's single purpose
- [ ] Data is not being used or transferred to determine creditworthiness or for lending purposes

## Screenshots — upload plan

**Specs:** 1280×800 (all 15 present frames already conform), PNG, max 5 shown as the featured
set, and **slot 1 is the hero**. The featured-5 order and the rationale for it live in
`store-assets/README.md` — that file is the source of truth, not duplicated here.

**These are 0.3.x-era and this is the release's weakest point.** Nothing that shipped after
0.3.x has a frame at all — no Schema Browser, Command Palette, Trace Flags, Field Impact
Analysis, side panel, or SOSL mode — and `final_06`, the hero, shows a Workspace nav from when
there were 13 tools. `final_14` and `final_15` are deleted pending recapture (one captured the
now-fixed SOAP API-version error live, the other leaked a real org id, company name and email).

The listing can be fully pre-positioned without touching these — the store keeps the existing
screenshots if none are uploaded. Recapturing is a separate human task against a scratch org,
never a production one, given what `final_15` leaked.

## Distribution
- Visibility: Public
- Regions: All
- Pricing: Free
