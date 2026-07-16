# Changelog

All notable changes to `@sfdt/extension` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Raw-JSON view on Inspect Record (P1-7).** The record inspector now has a **Fields / JSON** view toggle (a keyboard-reachable `role="tablist"` of two `<button>`s with `aria-selected` kept in sync). The JSON view shows the **raw REST record payload** — exactly what the worker-proxied API returned, including the `attributes` envelope — pretty-printed into a `<pre>` (built with `textContent`, never `innerHTML`), with a **Copy JSON** button. The selected view persists while the modal is open. The `sid` stays in the worker: the JSON view only renders the already-fetched payload, making no new Salesforce call. Design-token styled for light and dark; Esc/focus behaviour of the modal is unchanged.
- **Session-layer hardening — GovCloud, Defender proxy, and China org support (P0-5).** The background worker's Salesforce API resolution (still entirely worker-side; the `sid` never leaves the worker) now handles orgs served on non-standard domains and resolves the true instance more robustly:
  - **New host coverage** — US Government Cloud/GovCloud (`.mil`: `<org>.my.salesforce.mil` / `.lightning.force.mil`), Salesforce China (`.sfcrmapps.cn`), and orgs fronted by a **Microsoft Defender for Cloud Apps** reverse proxy (`.mcas.ms`). Ledgered new manifest `host_permissions` — `https://*.my.salesforce.mil/*`, `https://*.lightning.force.mil/*`, `https://*.sfcrmapps.cn/*`, `https://*.mcas.ms/*` — and matching cookie-read allowlist entries (least-privilege; only the `sid` cookie of these hosts is read, locally). Defender-proxied sessions correctly authenticate back through the proxy origin.
  - **SID-prefix (Org ID) cross-matching.** When several candidate base domains are in play, the worker cross-matches each candidate's `sid` prefix (the 15-char Org ID) against the page origin's, dropping any candidate whose cookie belongs to a *different* org you're also logged into — so a request is never authenticated with the wrong org's session. Fixes exotic domains where the naive host guess was wrong.
  - **Per-host session cache** in `chrome.storage.session` (memory-only, cleared when the browser closes; never `chrome.storage.local`, and never the `sid` — only the resolved API hostname + org id). Repeat calls read a single cookie instead of re-scanning candidate domains; a 401 or org switch invalidates the entry and re-resolves with no user action.
  - **Incognito isolation** — the manifest now declares `incognito: "split"`, so an incognito window resolves and caches its own sessions instead of sharing the normal profile's.
- **Dark mode.** The extension UI now has a dark theme, cashing in the P0-1 token consolidation — dark values for every `--sfdt-color-*` token live alongside the light ones in `lib/tokens.ts`, emitted under a `:root[data-sfdt-theme="dark"]` block plus a `@media (prefers-color-scheme: dark)` fallback. A new **Appearance › Theme** setting on the options page chooses `light`, `dark`, or `auto` (default); `auto` follows your OS live via a `prefers-color-scheme` listener, while a manual `light`/`dark` overrides the OS. The choice is a single global preference in `chrome.storage` (`settings.theme`), read on boot and applied on all three surfaces — the injected content-script UI (side menu, tools, modals), the Workspace app, and the options page — and it persists across browser restarts. Theming is scoped to the extension's own `--sfdt-*`-styled overlays; the host Salesforce page is untouched. Body text meets WCAG AA contrast in both themes. P0-1 had overloaded a few tokens (used as both a saturated fill and as coloured text); dark mode splits the foreground role onto dedicated tokens (`color-on-accent`, `color-text-strong`, `color-brand-text`, `color-error-text`, `color-success-text`) whose light values are identical to what they replaced, so the light theme is visually unchanged.
- **UX & accessibility conventions doc** (`extension/CONVENTIONS.md`) — a numbered a11y/overlay/keyboard/theme/shadow-root checklist that reviewer agents apply verbatim to every UI-bearing change, plus two annotated reference implementations (`setup-tabs`, `flow-list-search`). Codifies the overlay rules (Esc closes, focus trap + restore, dialog semantics, pin/click-outside dismiss), the `createElement`+`textContent`/zero-`innerHTML` DOM discipline, and the `var(--sfdt-color-*)` theme-token rule. Contributor-facing; ships no runtime code.
- **Packaging version-match guard** (`scripts/check-version-match.ts`) — the `package:ext` step now fails if `extension/package.json`'s version differs from the built manifest (`.output/chrome-mv3/manifest.json`), naming both versions and the file, so a stale build artifact can't be zipped and shipped. Runs in the Extension CI packaging job; documented in the new `extension/RELEASING.md`.
- **Toolbar action popup + keyboard shortcuts.** Clicking the extension's toolbar button now opens a thin popup showing, for the active tab: whether it's a Salesforce page and which org, a live-session status dot, a bridge (sfdt CLI) status dot, quick buttons for the Workspace / quick menu / Settings, and the extension version. On a non-Salesforce tab it shows a "not a Salesforce tab" state and makes zero org/API calls. Three declared keyboard commands are also added and are remappable at `chrome://extensions/shortcuts`: **Open Workspace** (`Ctrl/Cmd+Shift+E`), **Open quick menu** (`Ctrl/Cmd+Shift+K`, opens the ⚡ side menu until the command palette ships), and **Toggle inspector** (declared now; surfaces a "not available yet" notice until the LWC inspector lands). Because the commands are registered by the browser rather than by in-page keydown listeners, they work on a Salesforce tab even before the content script has finished loading. Session status is read in the service worker, never from the page, so the session cookie stays in the worker. No new permission is required — `commands` is a manifest key, not a permission.

### Changed
- **Security posture: the Salesforce session id (`sid`) no longer enters page-adjacent memory.** Every REST/Tooling/SOAP call now runs inside the background service worker via a new `sfApiFetch` message route (`lib/sf-api-proxy.ts`): the worker reads the `sid` cookie, injects `Authorization`, performs the dual-host fallback + one-time 401 retry, and returns only the response *text* — never the sid. `lib/salesforce-api.ts` is now a thin client that describes the call and parses the reply; it holds no sid and makes no Salesforce fetch of its own. SOAP calls send a sentinel placeholder that the worker swaps for the real sid inside the `SessionHeader` only. Request headers are allowlisted (any client-supplied `Authorization` is stripped). A guard test (`test/sid-never-leaves-worker.test.ts`) plus a scoped ESLint rule enforce that feature/UI code never touches `chrome.cookies`, the `getSidForUrls` route, `getSessionDetails`, or a raw `Authorization: Bearer` header. Internal refactor — no user-facing behaviour change.
- **SID-in-worker migration complete — zero exceptions.** The Event Streaming Monitor's CometD/Bayeux long-poll (the last page-side holder of a raw `sid`) now runs entirely in the service worker behind a long-lived `sfApiStream` Port (`lib/sf-stream-worker.ts`). The feature opens the Port, sends `subscribe`/`unsubscribe`, and renders only the `status`/`event` messages the worker pushes back — the sid never reaches the page. The residual page-side session machinery (`getSession`/`getSessionDetails`/`getSidForUrls` client path) is deleted, and both the guard test and the ESLint rule now allowlist nothing (they also fail on any `getSessionDetails` reference). This completes the P0-4 "SID never leaves the worker" guarantee. On MV3 service-worker eviction the Port disconnects and the monitor shows "Disconnected" with Subscribe re-enabled, so the user can reconnect. No new manifest permission (`chrome.runtime.connect` is a platform primitive). Internal refactor — no user-facing behaviour change. (Re-landed onto `develop` after the original approved change was stranded by a squash-merge into an intermediate branch that never reached `develop`.)
- **Shadow-DOM host for injected UI (internal, no visual change).** All content-script-injected UI on a Salesforce page — the ⚡ side button and its menu, `present-view` page-mode modals, and toasts — now renders inside ONE shared **closed** shadow root (`ui/shadow-host.ts` + `ui/content-root.ts`), fully isolating it from the host page's CSS in both directions: Salesforce's global styles can't bleed into our overlays, and our styles can't leak onto the page. This cuts the per-release visual breakage caused by Salesforce DOM/CSS churn. Dark mode is unaffected — the `--sfdt-*` design tokens stay defined on the host `:root` (custom properties inherit across the shadow boundary), so `var(--sfdt-*)` still resolves and flipping `data-sfdt-theme` on the host still re-themes the overlays live. Click-outside dismissal now uses `composedPath()` so it works correctly across the shadow boundary; Esc/focus behaviour is unchanged. Our own full-page surfaces (the Workspace app + options page) are not injected into a hostile document and stay in light DOM. Realises CONVENTIONS.md item 13 (previously a documented gap).
- **Single Salesforce API-version constant.** Divergent `v62.0` literals across features are consolidated into one authoritative `SF_API_VERSION` (`lib/api-version.ts`), re-exported by the client as `api.apiVersion`.
- **Design-token refactor (internal, no visual change).** Every hard-coded colour across the content-script features, the Workspace app page, the options page, and the shared `ui/` components (~770 hex literals in 38 files) is now a `var(--sfdt-color-*)` CSS custom property. The raw values live in one place — `lib/tokens.ts` — which each surface injects at boot (`ensureTokens()` on Salesforce pages; the `:root` token block prepended to the app/options stylesheets). This is a pure refactor with no user-facing change; it's the enabling step for a future single-switch dark theme, which can now supply dark values in one file instead of hunting colours across the codebase. One documented exception remains: the user-configurable `canvasSearch.highlightColour` default (`#FFD700`) stays a literal because it's runtime data string-concatenated with an alpha suffix and cannot be a CSS variable.

## [0.7.0] - 2026-07-14

### Added
- **API Version Audit** (`api-version-audit`) — an org-side pill in the Setup tab strip showing the org's max API version and release (e.g. `API v67 · 3 behind`). Click it to expand a panel of per-type API-version histograms — Apex classes, Apex triggers, and active Flows — with a bar per version and an org-max footer. Components below the shared `@sfdt/flow-core` API-version floor are banded amber (the same threshold the CLI's org-health checks use), and the pill itself turns amber when any component is behind. Runs entirely org-side against the Tooling API using your existing session — no bridge required.

### Fixed
- **`api-version-audit` panel now closes on click-outside.** It previously only closed on Escape, so the absolute panel could float over subsequent content after an SPA navigation; it now also dismisses on any click outside the pill/panel (matching the `rest-explore`/`soql-runner` dropdown pattern).
- **Relicensed MIT → Apache-2.0.** The README license line was corrected to Apache-2.0 to match the repository `LICENSE` and the extension's `package.json`.

## [0.6.0] - 2026-07-09

### Fixed
- **Org Health (bridge) is now registered.** The `org-health` feature — which surfaces the CLI's audit/monitor snapshots via the local bridge or native host (the `org-health` request kind) — was built, tested, and given an icon/label but never wired into any entrypoint, so it was unreachable. It's now registered on real Salesforce pages (`content.ts`) and in the Workspace, alongside the live-query "Org Health (Live)" tool. (It also now works when only the native host is available, per the host's new read-only-kinds support.)

### Added

- **Flow Scanner** — the `flow-quality` feature is now a full scanner. Beyond the score banner it renders the complete `@sfdt/flow-core` report: issue families (sorted by score impact) with severity, affected elements/resources, and the recommended fix, plus a Dependencies list (Apex actions, LWCs, subflows, Apex-defined types). It's also registered on real Salesforce pages (`content.ts`), so it works across Setup and Flow-list contexts by API name — not only inside the Flow Builder canvas like `flow-health-check`. In the Workspace, each dependency row has an **Explore** cross-link that opens it (mapped to its MetadataComponent type) in the org-wide Dependency Explorer, pre-filled and searched.
- **Org release badge** — the Workspace top bar and the live Setup tab strip (`org-release-badge` feature) now show the org's Salesforce release (e.g. `Summer '26`) and flag preview instances, matching the CLI's `monitor org-info` wording. Derived best-effort from the org's `/services/data` REST version list via the shared `@sfdt/flow-core` release logic (same "ahead of GA = preview" rule the CLI uses); the badge stays hidden if the release can't be read.
- **Field Access quick link** (`setup-tabs`) — on an Object Manager object page, the Setup tab strip gains a **Field Access** tab that jumps straight to that object's Field Access page (`/lightning/setup/ObjectManager/<Object>/FieldAccess/view`). Object-contextual: it reads the object from the current URL and only appears on Object Manager object pages.

## [0.5.0] - 2026-07-02

### Added
- **`show-api-names`** — annotate Lightning record detail pages with each field's API name next to its label (layout-describe driven, so duplicate labels resolve in layout order) and the object API name + 18-char record id in the header. Persistent on/off toggle plus copy helpers for the current record: 18-char Id, Apex `insert` statement (createable fields, typed literals), and a `SELECT` SOQL query.

### Fixed
- **`ai-assistant` now shows the AI's answer.** "Run via sfdt" previously confirmed receipt with a toast and discarded the response; it now renders the response (with provider and a copy button) in the panel, disables the button while running, and uses the long-running bridge timeout (60s) instead of the 8s default that real AI runs routinely exceeded.
- **`flow-version-manager` bulk delete no longer blanket-overrides `confirm()`.** The bypass now auto-accepts at most one native confirm per selected version and restores the original immediately after the last one, so an unrelated confirm firing in the same window can no longer be silently accepted.
- **`missing-descriptions` surfaces fetch failures.** A failed Flow-metadata fetch now shows an error toast (once per page load) instead of silently rendering nothing, so "no flags" is distinguishable from "check never ran".
- **Fewer false-positive trigger conflicts** (`flow-health-check`, `flow-trigger-explorer`). The bundled `@sfdt/flow-core` analysis now reads a record-triggered flow's event from `recordTriggerType` — previously every save-triggered flow's event read as "Unknown", collapsing distinct Create-only and Update-only flows into one conflict bucket.

## [0.4.0] - 2026-06-29

A Workspace-focused release: three new live-org tools, an Apex test runner, and a redesigned tabbed Workspace where tools keep their state instead of being dismissed by a stray click — plus a shared analysis rulebook with the rest of the SFDT suite via `@sfdt/flow-core`.

### Added
- **`code-coverage`** — Apex Code Coverage tool: org-wide percentage plus per-class bands (worst-covered first, the 75% deploy line flagged red). Reads the live org directly via the Tooling/REST client — no `sfdt ui` server required.
- **`org-health-live`** — Org Health (Live): runs checks against the org instead of reading a stale snapshot (Apex coverage, inactive users 90d+, license utilisation, Apex API-version spread, limits near cap). Resilient via `Promise.allSettled` — one failed query degrades to a red row, not a dead panel.
- **`dependency-explorer`** — "what references this / what does this reference" via `MetadataComponentDependency`, for Apex/Flow/field/page/LWC by name.
- **`apex-test-runner`** — run Apex tests asynchronously (`runTestsAsynchronous` + poll) from the Workspace.
- **`bridge-tools`** — surfaces the bridge request kinds (drift / scan / compare / quality) as Workspace tools.

### Changed
- **Tabbed Workspace.** Tools now open as persistent tabs in the main area instead of fixed overlays over the page. Each tab keeps its DOM and state when you switch away, only the tab's × closes it, and a stray background click can no longer discard a half-written query or form. New shared `present-view` presenter (classic modal on a Salesforce page, tab pane in the Workspace) and a unit-tested `workspace-tabs` lifecycle; all stateful editors and the remaining flow/Workspace tools were migrated, with live-resource teardown (event-monitor CometD stream, data-import workers) now running on tab close.
- **`flow-quality` runs Direct in the browser.** It fetches the Flow's metadata via Tooling and runs the shared `@sfdt/flow-core` rulebook in-browser, so it works for any user on any org without `sfdt ui` running — byte-identical scores to the CLI.
- **Shared analysis rulebook.** `code-coverage`, `dependency-explorer`, and `org-health-live` now import their pure logic from `@sfdt/flow-core` (one source of truth across CLI/GUI/extension); `org-health-live` sheds ~170 lines of duplicated logic and the usage bands unify to amber ≥75% / red ≥90%.
- **`drift-check`** gains a "Run live (slower)" option that triggers a full live drift before returning the snapshot.

### Fixed
- **`flow-deploy` Rollback** was dead (hard-coded to version 1, used the raw flow id, always errored). It now resolves the Flow's api name and deactivates it (toVersion 0), reporting success or failure.
- Fixed several latent listener leaks (soap-explore history click handler, inspect-record and ai-assistant Esc handlers) — now torn down on close.

## [0.3.3] - 2026-06-25

### Fixed
- `org-health` — the `BRIDGE_UNAUTHORIZED` error hint pointed at a non-existent `sfdt extension token` command. It now directs users to paste the bridge token from `~/.sfdt/bridge-token` (created when you run `sfdt ui`), matching the actual pairing flow.

### Changed
- Corrected the stale bridge-token rotation comment in `lib/settings.ts` (the old `sfdt extension token rotate` command does not exist) to describe the real flow: delete `~/.sfdt/bridge-token`, restart the bridge, and re-pair.

## [0.3.2] - 2026-06-24

> Version note: there is no 0.3.1 — the bump went straight from 0.3.0 to 0.3.2.

### Added
- `org-health` — **Org Health panel**: a side-button panel (modeled on `org-limits`) that surfaces the CLI's audit and monitor snapshots in the extension via the local bridge's new `org-health` request kind, rendering status dots, findings, and a Copy JSON action. Completes the fourth surface for the org-health feature set alongside the CLI, the web dashboard, and the VS Code extension.

### Changed
- `apex-anonymous` — **richer log capture & debugging**: adds SOQL builders, trace-flag management, and UI updates for executing and inspecting anonymous Apex (builds on the feature introduced in 0.3.0).
- **Internal namespace standardised to `sfdt`** across the extension (DOM ids, CSS classes, `chrome.storage` keys, log prefixes) so it matches the rest of the `@sfdt/*` project.

### Note
- The `chrome.storage.local` keys were renamed to the `sfdt.*` namespace with no migration shim. Users upgrading from an older build will start from default settings (and their opt-in telemetry resets); re-enabling preferences is a one-time step.

## [0.3.0] - 2026-06-20

### Added
- **Standalone Workspace tab** (`chrome-extension://…/app.html`) — a full-page workspace opened from the side button's "Open Workspace ↗". Tools run in their own browser tab, so dismissing a panel never costs the user their place on the Salesforce page. The Workspace hands features a synthetic window reporting the chosen org's Salesforce URL, satisfying both the API host derivation and each feature's `detectContext()` gate with zero per-feature edits (`CONTEXTS.WORKSPACE`, curated `WORKSPACE_TOOLS` allowlist).
- `apex-anonymous` — **Execute Anonymous Apex**: run anonymous Apex (`executeAnonymous`) with a snippet library.
- `debug-log-viewer` — **Debug Log Viewer**: list `ApexLog` records and view raw log bodies; honours the `pageSize` feature setting.
- `org-switcher` — **Multi-Org Switcher**: discover orgs the user is logged into (via a background `listSalesforceOrgs` action over `sid` cookies, deduped) and target tools at a chosen org.
- `saved-soql` — **Saved SOQL**: bookmark and re-run SOQL queries / history, loaded into the runner via a pending-query hand-off; honours the `showHistory` feature setting.

### Changed
- `salesforce-api` — `SalesforceApiClient` gains an explicit `targetOrigin` (+ `configureSalesforceApi` singleton binding) so it works from the `chrome-extension://` origin, plus `apiGetText()` for `text/plain` bodies (e.g. ApexLog).
- Feature `ICONS` map extracted to `lib/feature-icons.ts`, shared by `content.ts` and the Workspace shell.

## [0.2.1] - 2026-06-17

> Version-only republish — the bump was forced by a deploy issue. No feature or
> functional code changes; the entries below are metadata/listing copy only.

### Changed
- Broadened the extension's manifest description to reflect that it now spans Flow Builder, Setup, Object Manager, and record pages (schema/data/API tooling + AI), not just Flow analysis and Setup. Also refreshed the Chrome Web Store listing copy to match (24 features, broadened positioning) and consolidated the store-submission assets under `extension/store-assets/`.

## [0.2.0] - 2026-06-16

### Added
- `export-for-prompt` — **Export Schema for Prompt**: copy a dense Markdown schema for a Salesforce object to the clipboard for pasting into an LLM prompt. Works on record pages and Lightning **Object Manager** setup pages; resolves the object from the Object Manager URL segment or the record-page key-prefix, with a Tooling `EntityDefinition` fallback for durable-id URLs, and uses the REST describe endpoint for the full field list (label, type, required, inline help).
- `soql-runner` — **LangGraph Node generator**: a button that turns the current SOQL query and its result columns into a ready-to-paste LangGraph node definition (Pydantic result model + node stub).

### Changed
- `sfdt-bridge` — per-call `timeoutMs` option; deploy/rollback use a 60s long-running timeout; idempotent bridge kinds retry once on transport failure (mutating kinds and auth errors never retry); unsafe `response.data` casts replaced with a `getBridgeData<T>` runtime guard.
- `salesforce-api` — user-facing request errors shortened to HTTP status + extracted Salesforce message (full per-host detail moved to `console.error`); SOAP lookups match by `localName`, so namespace-prefixed (`<soapenv:…>`) envelopes parse correctly.
- `telemetry` — bridge failures tracked by category (offline/timeout/unauthorized/protocol/other) via an `onBridgeFailure` hook, emitted fire-and-forget.
- `background` — kill-switch ping retries once before reporting the bridge down.
- `feature-registry` — feature init failures surface a toast (teardown errors stay console-only).
- DOM updates across features use `replaceChildren()` instead of `innerHTML = ''`.
- `SalesforceApiClient.apiVersion` is now public/readonly, and remaining `any` casts in `soql-runner`/`event-monitor` were replaced with proper types.

### Fixed
- `export-for-prompt` is now reachable — it was missing from the `content.ts` ICONS map, so the menu builder dropped it and it could never activate.
- `killswitch-cache` — cached reads age out entries older than 24h (the timestamp was written but never checked); un-stamped legacy entries are treated as stale.
- `soql-runner`/`event-monitor` — GraphQL traversal uses type guards, fixing a latent crash on null records; `BayeuxMessage` is properly typed.

### Security
- `escapeCell` (`export-for-prompt`) escapes backslashes before pipes, closing an incomplete-Markdown-escaping issue (CodeQL `js/incomplete-sanitization`).
- `salesforce-api` error logging passes dynamic values as separate `console.error` arguments rather than interpolating them into the format string (CodeQL `js/tainted-format-string`).
- `generateLangGraphNode` escapes backslashes and double-quotes in the embedded SOQL so a query cannot break out of the generated Python triple-quoted string.
- `SF_ID_RE` now matches exactly 15 or 18 characters (it previously also accepted invalid 16/17-char strings).

## [0.1.0] - 2026-06-07

### Added
- `inspect-record` — **Inspect Record (Show All Data)**: view a record's complete field set (including empty and system fields) via the REST API. Available on record pages, Setup, and Flow Builder.
- `data-import` — **Data Import Wizard**: guided CSV-based data import into the org, with delimiter handling and CSV (de)serialization.
- `field-creator` — **Bulk Field Creator**: create multiple custom fields at once. Available on record pages, Object Manager / Setup, and Flow Builder.
- `metadata-retrieve` — **Metadata Retrieve & Deploy**: retrieve and deploy metadata directly from the browser.
- `soap-explore` — **SOAP API Explorer**: build and send SOAP API requests with a payload editor and response viewer.
- `event-monitor` — **Event Streaming Monitor**: subscribe to and monitor platform/streaming events live.

### Changed
- `soql-runner` — added field/object **autocomplete** while composing queries, alongside the existing history and CSV export.
- Expanded `context-detector` page-context mapping so the new features surface on the appropriate Setup, Flow Builder, Flow Trigger Explorer, and record pages.

### Security
- Hardened the optional `@sfdt/cli` GUI bridge: the `plugins` config key can no longer be set via the `PATCH /api/config` endpoint, closing a dynamic-`import()` code-execution path (security review M1).
