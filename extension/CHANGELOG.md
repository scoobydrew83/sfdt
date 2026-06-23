# Changelog

All notable changes to `@sfdt/extension` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **Internal namespace renamed from the legacy `sfut` to `sfdt`** across the extension (DOM ids, CSS classes, storage keys, log prefixes) so it matches the rest of the `@sfdt/*` project. User-facing behaviour is unchanged.
- `chrome.storage.local` keys moved `sfut.settings` → `sfdt.settings` and `sfut.telemetry` → `sfdt.telemetry`, with a one-time read-and-migrate on first access so existing users keep their settings and opt-in telemetry. The 24h kill-switch cache (`sfut.killswitch.cache` → `sfdt.killswitch.cache`) is intentionally not migrated — it self-heals on the next boot ping.

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
