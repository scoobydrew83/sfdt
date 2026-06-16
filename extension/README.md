# @sfdt/extension — SFDT SF Helper

A Chrome extension that augments Salesforce Flow Builder and Setup with productivity features for admins and developers. Works standalone; an optional local bridge to the [`@sfdt/cli`](../README.md) unlocks deploy, rollback, quality scoring, and AI-powered analysis directly from the canvas.

This is one of four workspaces in the [`sfdt` monorepo](../README.md):
- **`@sfdt/cli`** — the npm CLI that owns deployment, testing, release management.
- **`@sfdt/extension`** — *this package*: the Chrome extension.
- **`@sfdt/host`** — a tiny native-messaging host used when the CLI's HTTP bridge isn't running.
- **`@sfdt/flow-core`** — shared TypeScript library used by both the extension and the CLI.

---

## Features (24)

Every feature is opt-in (toggle off in the options page), and any feature can be remotely disabled without a Web Store re-review via `sfdt feature-flags disable <id>`.

| Id | What it does | Where it lives |
|---|---|---|
| `setup-tabs` | Adds Automation Home + reorderable tabs to the Setup tab bar | classic + lightning Setup |
| `missing-description-flags` | Flags Flow nodes / fields without descriptions inline | Setup Flows |
| `canvas-search` | Cmd/Ctrl+Shift+F search across nodes on the Flow canvas | Flow Builder |
| `flow-version-manager` | Side panel listing active/draft Flow versions with one-click activate / rollback (requires bridge) | Setup Flows |
| `api-name-generator` | Auto-generates API names from labels using configurable case style | Flow Builder, Object Manager |
| `scheduled-flow-explorer` | List + calendar view of all scheduled Flow runs in the org | Setup Flows |
| `flow-trigger-explorer-enhancer` | Adds bulk fetch + visual grouping to the native Trigger Explorer | Setup Flows |
| `flow-list-search` | Fuzzy search over the Flow Definitions list | Setup Flows |
| `flow-health-check` | Scores the currently-open Flow against the `@sfdt/flow-core` rules engine | Flow Builder |
| `flow-deploy` | Deploy the current Flow via the bridge (CLI's `sfdt deploy --metadata Flow:...`) | Flow Builder |
| `comparison-exporter` | Export org-vs-org compare reports from the canvas | Setup Flows |
| `ai-assistant` | Surface AI provider answers about the current Flow (Claude / Gemini / OpenAI via bridge) | Flow Builder |
| `subflow-graph` | SVG graph of subflow invocation relationships | Setup Flows |
| `trigger-conflicts` | Detects overlapping record-triggered Flows that would fire on the same change | Setup Flows |
| `soql-runner` | Run SOQL against the current org (REST or Tooling), with field/object autocomplete, history, CSV export, and a LangGraph node generator | Setup + Flow Builder + Trigger Explorer |
| `org-limits` | Live view of the org's governor-limit usage (sorted by pressure, colour-banded) | Setup + Flow Builder + Trigger Explorer |
| `rest-explore` | Fire arbitrary GET/POST/PATCH/PUT/DELETE against `/services/data/...` with response viewer + history | Setup + Flow Builder + Trigger Explorer |
| `inspect-record` | Inspect a record's complete field set (including empty/system fields) via the REST API | Record page + Setup + Flow Builder |
| `data-import` | Guided CSV data import into the org | Record page + Setup + Flow Builder |
| `field-creator` | Bulk-create multiple custom fields at once | Record page + Object Manager + Flow Builder |
| `metadata-retrieve` | Retrieve and deploy metadata directly from the browser | Record page + Setup + Flow Builder |
| `soap-explore` | Build and send SOAP API requests with a payload editor + response viewer | Record page + Setup + Flow Builder |
| `event-monitor` | Subscribe to and monitor platform/streaming events live | Record page + Setup + Flow Builder |
| `export-for-prompt` | Copy a dense Markdown schema for an object to the clipboard for pasting into an LLM prompt | Record page + Object Manager |

Adding the next feature is a one-file change — see the existing modules in [`extension/features/`](./features/) and the registry in [`extension/lib/feature-registry.ts`](./lib/feature-registry.ts).

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

(Pending submission.)

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

MIT — see [../LICENSE](../LICENSE).
