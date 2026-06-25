# Extension smoke-test plan (Phase 6 checkpoint)

Tests the unpacked Chrome extension against real Salesforce orgs. Walk
through each section in order; report breakages as a single list at the
end.

The build under test:

```
extension/.output/chrome-mv3/
├── manifest.json
├── background.js
└── content-scripts/content.js
```

Produced by `npm run build:ext` from the sfdt repo root.

---

## Pre-flight

1. **Rebuild the extension** so `.output/` reflects the latest source:
   ```
   cd /Users/dkennedy/dev/sfdt
   npm run build:flow-core
   npm run build:ext
   ```
2. **Load unpacked** into Chrome:
   - `chrome://extensions/` → Developer Mode ON → "Load unpacked" →
     pick `extension/.output/chrome-mv3/`.
   - Extension should appear as "SFDT SF Helper" v0.3.2.
   - Note the assigned extension ID (will need it for Phase 7 native
     messaging manifests).
3. **Confirm the manifest looks right** in `chrome://extensions/`:
   - host_permissions for the 4 Salesforce domains
   - permissions: storage, clipboardWrite, cookies
   - No yellow / red error banners
4. **Open the DevTools console** for the Salesforce tab you'll use:
   `Cmd+Opt+I` → Console. Anything tagged `[SFDT]` should be informational;
   anything red is a regression.
5. **Pick a target org**: a scratch org or sandbox with a mix of flow
   types (at minimum: one screen flow, one record-triggered, one
   scheduled, two record-triggered flows on the same object — for the
   conflict detector).

---

## Shell (Phase 3)

Before touching any feature, verify the shell itself.

| Check | Expected |
|---|---|
| Side button (⚡, top-right floating) appears on Lightning + Setup pages | yes |
| Side button does **not** appear on non-Salesforce pages | yes |
| Clicking it opens a menu pinned to its left | yes |
| Menu lists items appropriate to the current context (see matrix below) | yes |
| Closing via × or outside-click works | yes |
| SPA navigation (e.g. clicking from Setup to Object Manager) refreshes the menu | yes |
| Console contains `[SFDT] Shell mounted.` | yes |
| Console contains no red errors | yes |

The side button must mount in the top frame only — verify by opening a
classic-VF page (e.g. Flow Details) and confirming the button doesn't
appear inside the iframe.

---

## Per-feature matrix

Each row is one feature. Walk through in this order so you don't have to
flip between Salesforce pages repeatedly.

### Setup → Object Manager (or any generic Setup page) — context `SETUP_OTHER`

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 1 | **setup-tabs** | Side menu → "Setup Tabs" | First click: enables. Tab bar gets "Flows", "Flow Trigger Explorer" (opens new tab), "Process Automation Settings" injected. Second click: removes them. Toast confirms. | Full port |
| 2 | **scheduled-flow-explorer** | Side menu → "Scheduled Flow Explorer" | Modal opens, shows "Discovering scheduled flows…", then lists every Schedule-Triggered Flow with its next run time and "in N days" relative descriptor. | Full port (calendar view deferred) |
| 3 | **trigger-conflicts** | Side menu → "Trigger Conflicts" | Modal opens, lists groups where ≥2 record-triggered flows share Object · Timing · Event. If none, shows celebratory empty state. | Phase 6, full |
| 4 | **subflow-graph** | Side menu → "Subflow Caller Graph" | Modal opens, shows total flow count, cycles in a red banner at top (if any), then per-flow depth + outgoing call chains. | Phase 6, full |

### Setup → Flows list page — context `SETUP_FLOWS`

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 5 | **flow-list-search** | Auto-injects above the list header on page load | Search bar with "Search by label or API name…", Status + Type filters, Clear button, live count label | Full port |
| | Setup Tabs / Scheduled / Conflicts / Graph also work here — same as above | | | |

### Flow Details page (classic VF) — context `FLOW_DETAILS`

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 6 | **flow-version-manager** | Auto-injects checkboxes per row + "Delete Selected Versions" button in the toolbar | Checkboxes disabled on active versions. Selecting one or more inactive versions enables the bulk-delete button. Clicking opens a confirm modal requiring you to type DELETE. | Full port (queue-resume deferred — bulk delete loops directly instead) |

### Flow Builder canvas — context `FLOW_BUILDER`

Open any flow in Flow Builder so the canvas is visible.

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 7 | **canvas-search** | Ctrl+Shift+F (default) or side menu → "Search & Highlight" | Search bar floats at top of canvas. Type a label fragment; matching cards get a gold highlight; Enter cycles through them; the canvas pans to centre the focused match. | Full port |
| 8 | **missing-descriptions** | Side menu → "Show Missing Description Flags" | After a brief load, ⚠ markers appear in the top-right of each canvas card whose element lacks a description. Toggling again removes them. Flow-level ⚠ appears next to the flow name if the flow itself has no description. | Full port |
| 9 | **flow-health-check** | Side menu → "Run Health Check" | Modal: header with flow name + type + API version + score. Severity card grid (High/Medium/Low/Info). Collapsible "Issue Families" list. "Flow Profile" metrics grid. Copy JSON button works. | Full port (uses flow-core; should match `sfdt flow scan` output) |
| 10 | **ai-assistant** | Side menu → "Flow Metadata & AI Assistant" | Panel: flow label heading, token estimates (raw vs cleaned), prompt template picker, Copy Raw / Copy Clean / Copy Prompt / Run via sfdt buttons. | Full port. "Run via sfdt" will say "Bridge not running" unless you have `sfdt ui` up. |
| 11 | **api-name-generator** | Side menu → "API Name Generator" | Modal with label input + element-type dropdown + naming-pattern dropdown + live monospaced preview. "Copy" copies the generated name. | Standalone modal (Flow Builder in-modal hooks deferred — verify the standalone variant works) |
| 12 | **flow-deploy** | Side menu → "Deploy or Rollback…" | Modal with Deploy / Rollback / Cancel buttons. Clicking Deploy: toast "Deploying…" then toast "Deploy/rollback ships with Phase 7…" (because the bridge handler is intentionally stubbed). | UI shipped; server-side handler is Phase 7 |

### Compare Flows view — context `COMPARE_FLOWS`

Open a Flow → click the version dropdown → pick "Compare Versions".

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 13 | **comparison-exporter** | Side menu → "Comparison Exporter" | Triggers a download: `flow-comparison-<timestamp>.tsv`. Open in Excel / Sheets — should have Element / Change / Field Changed / Old Value / New Value columns. | TSV ships; XLSX deferred until xlsx asset is wired |

### Flow Trigger Explorer — context `FLOW_TRIGGER_EXPLORER`

Open the Flow Trigger Explorer setup page.

| # | Feature | How to trigger | Expected | Known status |
|---|---|---|---|---|
| 14 | **flow-trigger-explorer-enhancer** | Side menu shows the entry, click it | No-op for now (out of beta promotion = the batch-fetch helper). DOM badges deferred. | Stub registered |

---

## Settings → Bridge pairing (only needed for #10 + #12)

The `flow-deploy` feature and "Run via sfdt" in the AI Assistant both call
the sfdt bridge. To exercise the localhost transport:

1. In a separate terminal, in any sfdt-initialised project, run `sfdt ui`.
   Note the printed port (default 7654).
2. Find the bridge token at `~/.sfdt/bridge-token` (created on first
   request to the running server). Copy the contents.
3. Open the extension's options page (via the side menu → ⚙ Settings, or
   right-click the extension → Options — currently **no options page is
   wired**, so this step is the next gap to fill).

Since the options page is not yet built, **for the smoke-test set the
token manually in DevTools**:

```js
chrome.storage.local.get('sfdt.settings', (s) => console.log(s));
chrome.storage.local.set({
  'sfdt.settings': {
    ...((await chrome.storage.local.get('sfdt.settings'))['sfdt.settings'] || {}),
    bridge: { token: 'PASTE_TOKEN_HERE', preferredTransport: 'localhost', localhostPort: 7654 },
  },
});
```

Then verify:
- Open the AI Assistant panel → click "Run via sfdt" → response should
  read "Bridge returned NOT_IMPLEMENTED" (the `ai` kind is not wired yet).
- Open Flow Deploy → Deploy → response should read the same.

Both error messages should be USER-FACING and friendly — no stack traces.

---

## What to report

Three lists, terse:

1. **Worked**: feature numbers that did exactly what the matrix says.
2. **Broken**: feature numbers with what went wrong (one line each).
3. **Surprises**: anything you noticed that isn't in the matrix —
   performance issues, ugly styling, console warnings beyond expected
   `[SFDT]` info, mouse-trap problems, accessibility gaps.

The deferred-status column above is what I already know is incomplete;
focus the "Broken" list on things that don't match what the matrix
promises.

---

## Quick re-test loop

After we fix anything from the report:

```
cd /Users/dkennedy/dev/sfdt
npm run build:flow-core && npm run build:ext
```

Then in `chrome://extensions/` click the reload icon on the extension
card, then refresh the Salesforce tab. No re-pair needed unless I rotate
the bridge token.
