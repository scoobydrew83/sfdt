# Changelog

All notable changes to `@sfdt/extension` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
