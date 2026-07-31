# @sfdt/extension — SFDT for Salesforce

A Chrome extension that augments Salesforce Flow Builder and Setup with productivity features for admins and developers. Works standalone; an optional local bridge to the [`@sfdt/cli`](../README.md) unlocks deploy, rollback, quality scoring, and AI-powered analysis directly from the canvas.

This is one of four workspaces in the [`sfdt` monorepo](../README.md):
- **`@sfdt/cli`** — the npm CLI that owns deployment, testing, release management.
- **`@sfdt/extension`** — *this package*: the Chrome extension.
- **`@sfdt/host`** — a tiny native-messaging host used when the CLI's HTTP bridge isn't running.
- **`@sfdt/flow-core`** — shared TypeScript library used by both the extension and the CLI.

---

## Workspace tab

Click the ⚡ side button on any Salesforce page and choose **Open Workspace ↗** to launch a
standalone full-page tab (`chrome-extension://…/app.html`). The Workspace hosts the extension's
tools — SOQL first — in their own browser tab, so opening a query runner or executing Apex never
disturbs the Salesforce page you were on, and closing a tool's modal no longer loses your place.

- **Org targeting** — the Workspace opens against the org you launched it from. With no org in the
  URL it falls back to your last-used org, then to an **org picker** listing every Salesforce org
  you're currently logged in to (detected from session cookies).
- **Switch org** — the top bar's *Switch org* button reloads the Workspace against another logged-in
  org, cleanly rebuilding every tool's session.

The Workspace works without a content script on the page — features run against a *synthetic*
window that reports the chosen org's URL, so the existing tools run unchanged.

---

## Features

Every feature is opt-in (toggle it off in the options page), and any feature can be remotely
disabled without a Web Store re-review via `sfdt feature-flags disable <id>`.

**The authoritative list — every feature id, its display name, the Salesforce contexts it runs
in, and whether it needs the bridge — is [`generated/chrome-features.json`](../generated/chrome-features.json).**
That file is generated from `lib/feature-manifests.json` by `npm run generate:catalogs`, and it
is what the docs site and the skills pack consume, so it cannot disagree with what actually
ships. This README deliberately does **not** restate it. A hand-copied feature table and a
hand-incremented count are precisely the things that drift between releases: until 0.11.0 this
section carried both, and by then the count was wrong and several shipped features were missing
from the table. A number that has to be updated by hand is wrong again by the next release, so
there is no number here. `generated/` is never hand-edited (root [`CLAUDE.md`](../CLAUDE.md),
invariant #2); regenerate it with `npm run generate:catalogs` and commit the diff instead.

For a reader-friendly view of the same list, open the extension's **options page** — it is
registry-driven, so every shipped feature appears there with its toggle and settings.

What those features cover, described in categories that outlive any individual feature:

- **Navigation and workspace** — Setup tab customisation and grouping, a keyboard-driven command
  palette, multi-org switching, and the standalone Workspace tab / docked side panel above.
- **Flow tooling** — inline missing-description flags and health scoring on the canvas, search
  across canvas nodes, Flow version management, scheduled-Flow and trigger-explorer views,
  subflow graphs, trigger-conflict detection, and API-name generation from labels.
- **Schema and dependency exploration** — browsing objects, fields and relationships; tracing
  what references a component; tracing what *writes* a given field; and exporting a dense
  Markdown schema for an LLM prompt.
- **Query and API consoles** — SOQL and SOSL with autocomplete, history, bookmarks and CSV
  export, plus REST and SOAP explorers against the org you are already authenticated to.
- **Apex, logs and events** — anonymous Apex execution, asynchronous test runs, code coverage,
  debug-log retrieval and profiling, trace-flag / debug-level management, and live
  platform-event monitoring.
- **Record and data tooling** — full record inspection (including from a right-click), inline
  field API names on record pages, guided CSV import, bulk custom-field creation, and metadata
  retrieve / deploy.
- **Org diagnostics** — governor-limit pressure, per-type API-version audits, live org-health
  checks, and the org's release information.
- **Bridge-backed tools** — deploy, rollback, org compare, drift check, metadata scan and AI
  analysis, which need the local `@sfdt/cli` bridge described below.

Adding the next feature is a one-file change — see the existing modules in
[`extension/features/`](./features/) and the registry in
[`extension/lib/feature-registry.ts`](./lib/feature-registry.ts). A new feature must also be
declared in `lib/feature-manifests.json` (parity-tested) so it reaches the catalog above.
Keeping this README, [`PRIVACY.md`](./PRIVACY.md), the store listing and the screenshots honest
against what shipped is the release doc-staleness sweep's job — see
[`RELEASING.md`](../RELEASING.md) §5, "Chrome extension".

---

## Installation

### From source (during development)

```bash
# From the repo root:
npm install
npm run build:ext      # builds flow-core + extension
# Load extension/.output/chrome-mv3 as an unpacked extension in chrome://extensions
```

### From the Chrome Web Store

The extension is published to the Chrome Web Store as **SFDT for Salesforce**. (The store item
was previously titled "SFDT SF Helper"; see [`listing.md`](./listing.md) for the store copy.)

Publishing is automated rather than manual: merging an `extension/package.json` version bump to
`main` makes [`.github/workflows/extension.yml`](../.github/workflows/extension.yml) tag
`ext-vX.Y.Z`, attach the built zip to a GitHub Release, and upload to the Web Store with
`--auto-publish`. **Store review takes days**, so the version live on the store can lag this
repo — [`CHANGELOG.md`](./CHANGELOG.md) is the source of truth for what a given version
contains.

---

## Bridge — connecting to a local sfdt CLI

The extension can run completely standalone. To unlock deploy/rollback/quality/AI features, install the sister CLI and start the local server:

```bash
npm install -g @sfdt/cli
cd your-salesforce-project
sfdt init        # one-time .sfdt/ setup
sfdt ui          # starts http://localhost:7654 + the bridge
```

In the extension's options page, paste the bridge token from `~/.sfdt/bridge-token` and click **Test connection**.

The bridge speaks a versioned wire protocol (`packages/flow-core/src/bridge-contract.ts`). The extension warns on minor mismatches and refuses to send requests on major mismatches.

### Native messaging fallback

If you can't keep `sfdt ui` running, the extension can talk to the CLI through Chrome's native messaging instead:

```bash
sfdt extension install-host --extension-id <your extension id>
sfdt extension status     # verify
```

---

## Kill-switch (no Web Store re-review needed)

Any feature can be disabled remotely. The extension reads `<project>/.sfdt/feature-flags.json` on every bridge ping; the entry there overrides the user's per-feature toggle.

```bash
sfdt feature-flags disable canvas-search   # turn off
sfdt feature-flags list                    # what's currently disabled
sfdt feature-flags enable canvas-search    # turn back on
sfdt feature-flags clear                   # re-enable everything
```

---

## Telemetry

**Opt-in. Local-only. No network egress.**

When you toggle "Enable local telemetry" in the options page, the extension counts feature activations / errors / remote-disables in `chrome.storage.local`. Counts roll over each calendar month and are capped at 500 distinct feature ids. Nothing leaves the browser profile.

When the bridge is reachable AND telemetry is enabled, opening the options page pushes a snapshot to `<project>/.sfdt/telemetry-snapshot.json` so the CLI can render it:

```bash
sfdt extension stats          # top features by activation count
sfdt extension stats --json   # for scripts
```

See [PRIVACY.md](./PRIVACY.md) for the full data-handling policy.

---

## Diagnostics

Something not working? Run the bundled doctor:

```bash
sfdt doctor --extension
```

Checks the bridge, the native host, the kill-switch file, and the telemetry snapshot.

---

## Development

```bash
# From the repo root:
npm run test:extension     # vitest in the extension workspace
npm run build:ext          # WXT build
npm run package:ext        # build + zip for Web Store submission
```

The extension is structured around a small **feature registry** ([`lib/feature-registry.ts`](./lib/feature-registry.ts)). Each feature declares its contexts (which Salesforce pages it runs on) and optional Zod settings schema on a `manifest` block. The options page is registry-driven — adding a feature with a settings schema makes its controls appear automatically.

Architecture overview lives in the root [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md).

---

## License

Apache-2.0 — see [../LICENSE](../LICENSE).
