# Mini-plan: Visual Manifest Builder (GUI · VS Code · Chrome)

**Date:** 2026-07-29 · **Status:** SHIPPED — all four PRs landed. Kept for the
decision record and the architecture diagram; the design is no longer pending.

| PR | Deliverable | Where it lives now |
|----|-------------|--------------------|
| PR-1 | GUI builder page | `gui/src/pages/ManifestBuilder.jsx` |
| PR-2 | VS Code inheritance | `sfdt.manifestBuilder` command (`vscode/package.json`) |
| PR-3 | Bridge kinds | `manifest.discover` / `manifest.render` (`packages/flow-core/src/bridge-contract.ts`, contract 1.3) |
| PR-4 | Chrome extension | `extension/features/metadata-retrieve.ts` — "Metadata Retrieve & Deploy" |

The extension surface is named for what it does, not for this plan, which is why
searching for "manifest builder" in `extension/` finds only the header comment.
**Satisfies:** Chrome Extension Execution Plan items P5-4 (package.xml builder) and P5-5
(destructiveChanges.xml builder), pulled forward ahead of Phase 4 by decision 2026-07-29,
with scope broadened to the GUI and VS Code. P5-4 is an "L — mini-plan first" item; this
is that mini-plan.

## Problem

sfdt can build manifests from git diffs (`sfdt manifest`), from org-compare selections
(GUI CompareTable), and by editing an existing file (GUI add/remove component) — but it has
no changeset-style builder: browse metadata by type, tick checkboxes, watch a live
package.xml preview, save/deploy. The Chrome extension's `metadata-retrieve.ts` proves the
UX but is a 946-line island with its own XML writer, disconnected from the CLI engine.

## Decisions (2026-07-29, recorded verbatim)

1. **Sequencing:** all three surfaces now — P5-4/P5-5 pulled ahead of Chrome Phase 4.
2. **Sources:** org inventory **and** local source tree. No git-delta pre-seed (that
   remains `sfdt manifest` / smart-deploy's job).
3. **VS Code:** inherits the GUI page through the existing dashboard iframe
   (`DashboardController`). No native webview.
4. **Modes:** additive (package.xml) and destructive (destructiveChanges.xml + empty
   package.xml pair) ship together, one builder with a mode toggle.

## Architecture: one engine, one UI, three transports

```
                    ┌───────────────────────────────┐
                    │  Engine (existing, CLI-side)  │
                    │  org-inventory.js  listMetadata│
                    │  metadata-mapper.js renderPackageXml
                    └──────┬──────────────┬─────────┘
                           │              │
              gui-server routes      bridge kinds (flow-core contract)
                           │              │
        ┌─────────────┐    │         ┌────┴─────────┐
        │ GUI page    │◄───┘         │ Chrome ext.  │
        │ (React)     │              │ metadata-    │
        └─────┬───────┘              │ retrieve.ts  │
              │ iframe                └──────────────┘
        ┌─────┴───────┐               (offline fallback:
        │ VS Code     │                SOAP listMetadata,
        │ Dashboard   │                as today)
        └─────────────┘
```

**Single-writer rule:** every surface renders XML through
`renderPackageXml(metadata, apiVersion)` (`src/lib/metadata-mapper.js`). The Chrome
extension's private `generatePackageXml()` is retired when the bridge is connected and
kept only as the offline fallback (or replaced by a vendored pure function from
flow-core — decided in PR-3).

## Work plan (one PR per item, per repo convention)

### PR-1 — Server engine + GUI builder page

New/changed routes in `src/lib/gui-server/index.js`:

| Route | Purpose |
|---|---|
| `GET /api/manifest/discover-org?org=&type=` | Org members for one type via `org-inventory.js#listMetadataMembers`; `GET …&types=1` variant lists types via `listMetadataTypes`. Serve from `logs/scan-latest.json` when fresh; `?refresh=1` re-fetches. |
| `GET /api/manifest/discover` | Exists (local glob). Fix: `gui/src/api.js#discoverComponents` never passes the supported `package` param. |
| `POST /api/manifest/render` | `{items:[{type,member}], mode:'additive'|'destructive', apiVersion}` → XML via `renderPackageXml`. Destructive returns the pair `{destructiveChangesXml, emptyPackageXml}`. (Generalises the existing `POST /api/compare/manifest`.) |
| `POST /api/manifest/save` | Batch save (replaces the per-component round-trip loop in `Manifests.jsx:80`); writes to `config.manifestDir` with the `rl-…-package.xml` / `-destructiveChanges.xml` naming; refuses `deployed/`. |

New GUI page `gui/src/pages/ManifestBuilder.jsx` (Release group in `gui/src/routes.js`):

- Two-panel browser modeled on `Scan.jsx:161` (type list ↔ member grid) with the selection
  model from `CompareTable.jsx` (per-row + per-type-header checkboxes, filters,
  "N selected" bulk bar, select-all).
- Source toggle **Org | Local** (org uses discover-org; local uses discover).
- Mode toggle **Additive | Destructive** — destructive gets prominent warning styling and
  the paired-file explanation (link to `SFDT_DESTRUCTIVE_TIMING` docs).
- Live XML preview pane (pattern: `ManifestViewer` in `Manifests.jsx:159`) updating on
  every tick; wildcard (`*`) when a whole type is ticked; copy/download/save.
- Selections persist per org (localStorage keyed by org alias), clear-all.
- Registration checklist: `GUI_ROUTES` entry + `ICONS`/`PAGES` in `gui/src/App.jsx`
  (boot-time throw if missing) + `npm run generate:catalogs` + `npm run build:gui`.

### PR-2 — VS Code inheritance

- Fix the deep-link gap: `gui/src/App.jsx:117` initializes `useState('dashboard')` and
  ignores `window.location.pathname`; read the path on boot so
  `dashboardPageUrl(port, 'manifest-builder', …)` actually lands on the builder.
- Add command `sfdt.manifestBuilder` opening `DashboardController` at the builder page;
  contribute it next to the existing `sfdt.manifest` terminal command.
- No new webview infra, honoring the "CLI-backed, no reimplemented logic" rule
  (`docs/PATTERNS.md:20`).

### PR-3 — Bridge kinds (flow-core contract + host mirror)

- `packages/flow-core/src/bridge-contract.ts`: add read-only kinds
  `manifest.discover` (type list / members for a type, backed by `org-inventory.js`) and
  `manifest.render` (items+mode → XML via `renderPackageXml`). Minor protocol bump
  1.2 → 1.3 (`negotiateProtocolVersion` warns, doesn't refuse).
- Mount in `src/lib/bridge/routes.js` (HTTP) **and** mirror in `host/src/index.js` —
  both kinds are read-only/pure, so they are native-host-eligible (the host's
  "read-only fallback" policy holds; no write kind added).
- Lockstep: flow-core version bump, contract types imported by extension + routes + host.

### PR-4 — Chrome extension refactor (delivers P5-4 + P5-5 AC)

- `extension/features/metadata-retrieve.ts`: when the bridge is connected, source the
  type/member tree from `manifest.discover` and XML from `manifest.render`; offline
  keeps today's worker-proxied SOAP `describeMetadata`/`listMetadata` path (P5-4's spec
  already requires the offline mode).
- Add the destructive mode toggle (P5-5) with warning styling and paired-file output.
- Selections persist per org (`chrome.storage.local`), clear-all.
- All Notion Global DoD items apply: feature-registry manifest, kill switch, no
  `innerHTML`, tokens, Vitest, a11y checklist, CHANGELOG, docs-site MDX, no new
  permissions (none needed — ledger untouched).
- P5-6 (browsable picker in metadata-retrieve) becomes trivial afterward: the tree is
  already this feature's UI.

## Invariants this touches (from golden-principles/MEMORY_BANK)

- JSON envelope stays stdout-only; the new routes/kinds return raw JSON like their peers.
- `src/lib/command-policy.js:181` marks `manifest` as `supportsJson:false`, `surfaces.gui:false`
  — revisit in PR-1 if the builder is surfaced through command policy at all (routes may
  make this moot; do not flip casually).
- `generated/*` catalogs regenerate after the GUI route addition; CI fails on drift.
- No new config keys expected; if one appears, template + schema + consumer move together.
- Beta/license-gated org behavior: `listMetadata` failures degrade to a visible error
  state, never a fabricated empty tree.
- One feature per session: PR-1 through PR-4 are separate sessions/PRs against `develop`.

## Verification (end-to-end)

1. PR-1: build a manifest from org + local sources in the GUI; `sf project deploy validate`
   accepts the generated package.xml against a real org (manual, documented in PR).
   Destructive pair validates with the documented pre/post timing flow.
2. PR-2: `sfdt.manifestBuilder` in VS Code opens the panel directly on the builder page.
3. PR-3: `npx vitest run` in flow-core + host contract tests; version negotiation
   warns (not refuses) against a 1.2 client.
4. PR-4: extension verification gates (`npx vitest run`, `tsc --noEmit`, `eslint`,
   `wxt build`) + manual smoke with `sfdt ui` running; bridge-connected XML is
   byte-identical to `renderPackageXml` output for the same selection.
