import { z } from 'zod';
import {
  isFeatureEnabled,
  loadSettings,
  patchSettings,
  type Settings,
} from '../../lib/settings.js';
import { createBridgeClient, getBridgeData } from '../../lib/sfdt-bridge.js';
import { createFeatureRegistry } from '../../lib/feature-registry.js';
import { validateCustomShortcuts } from '../../lib/custom-shortcuts.js';
import { buildField } from '../../lib/zod-to-dom.js';
import { createTelemetry } from '../../lib/telemetry.js';
import { clearActivity } from '../../lib/activity-log.js';
import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';
import { SFDT_COMPONENT_CSS } from '../../lib/ui-styles.js';
import { icon } from '../../lib/icons.js';
import { watchTheme, OWN_PAGE_COLOR_SCHEME_CSS, type ThemeSetting } from '../../lib/theme.js';

// Pull every feature factory in so each module's top-level
// registerSettingsShape() call lands before loadSettings() runs.
import { createSetupTabsFeature } from '../../features/setup-tabs.js';
import { createCanvasSearchFeature } from '../../features/canvas-search.js';
import { createFlowListSearchFeature } from '../../features/flow-list-search.js';
import { createFlowHealthCheckFeature } from '../../features/flow-health-check.js';
import { createMissingDescriptionFlagsFeature } from '../../features/missing-description-flags.js';
import { createFlowVersionManagerFeature } from '../../features/flow-version-manager.js';
import { createAiAssistantFeature } from '../../features/ai-assistant.js';
import { createScheduledFlowExplorerFeature } from '../../features/scheduled-flow-explorer.js';
import { createApiNameGeneratorFeature } from '../../features/api-name-generator.js';
import { createComparisonExporterFeature } from '../../features/comparison-exporter.js';
import { createFlowTriggerExplorerEnhancerFeature } from '../../features/flow-trigger-explorer-enhancer.js';
import { createTriggerConflictsFeature } from '../../features/trigger-conflicts.js';
import { createSubflowGraphFeature } from '../../features/subflow-graph.js';
import { createFlowDeployFeature } from '../../features/flow-deploy.js';
import { createSoqlRunnerFeature } from '../../features/soql-runner.js';
import { createOrgLimitsFeature } from '../../features/org-limits.js';
import { createRestExploreFeature } from '../../features/rest-explore.js';
import { createApexAnonymousFeature } from '../../features/apex-anonymous.js';
import { createDebugLogViewerFeature } from '../../features/debug-log-viewer.js';
import { createSavedSoqlFeature } from '../../features/saved-soql.js';
import { createOrgSwitcherFeature } from '../../features/org-switcher.js';
import { createContextMenuInspectFeature } from '../../features/context-menu-inspect.js';
import { createRecordDeleteFeature } from '../../features/record-delete.js';
import { createSoqlBulkDeleteFeature } from '../../features/soql-bulk-delete.js';
import { createSoqlNlGenerateFeature } from '../../features/soql-nl-generate.js';
import { BRIDGE_REQUIRED } from '../../lib/feature-defaults.js';


// Options-page LAYOUT only. Card, button and glyph primitives come from
// lib/ui-styles.ts (SFDT_COMPONENT_CSS), injected alongside this — the `section`
// and `button` rules that used to live here restated the shared components with
// slightly different radii and padding, which is the drift this consolidation
// exists to stop.
//
// Bare element selectors are fine on THIS surface (it owns its whole document,
// unlike the content-script sheet), so form controls stay element-scoped.
//
// `.status` carries `white-space: pre-line` because two sites below render an
// org failure into it — the bridge ping's `response.error` and the save
// handler's caught value — and since `lib/sf-error-guidance.ts` that text is
// `[orgText, ...notes].join('\n')`. Without the rule the guidance line runs into
// the org's own text on one line: the #308 defect, on a surface the newlines
// guard could not see, because its walk was flat and everything under
// `entrypoints/*/` was unreachable even with the directory in SCANNED_DIRS.
//
// Keep prose out of the sheet itself. `STYLES` is assigned through
// `styleTag.textContent`, so a CSS comment naming a thrown value makes the
// stylesheet read as a rendered failure and the guard fires on the style tag —
// which it did, at `main.ts:221`, on the first draft of this note.
const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font: var(--sfdt-type-body-md);
    background: var(--sfdt-color-surface-alt);
    color: var(--sfdt-color-text-strong);
    margin: 0;
    padding: var(--sfdt-space-8) var(--sfdt-space-6);
  }
  /* 720px was right for one column; two need room to be two. Below the
     .sfdt-bento breakpoint it collapses back to a single column anyway. */
  .wrap { max-width: 1100px; margin: 0 auto; }
  h1 {
    /* The 22px this replaced was arbitrary — one step off the scale for no
       reason, which is the whole failure mode a type scale prevents. */
    font: var(--sfdt-type-headline-lg);
    margin: 0 0 var(--sfdt-space-1);
    display: flex;
    align-items: center;
    gap: var(--sfdt-space-2);
  }
  .subtitle { color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); margin: 0 0 var(--sfdt-space-6); }

  /* Cards carry '.sfdt-card-section' for the page padding and rhythm; the
     surface, border, radius and elevation all come from '.sfdt-card'. */
  section h2 { font: var(--sfdt-type-headline-md); margin: 0 0 var(--sfdt-space-1); }
  section p.section-help { color: var(--sfdt-color-text-weak); font: var(--sfdt-type-body-sm); margin: 0 0 var(--sfdt-space-3); }

  label.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sfdt-space-3);
    padding: var(--sfdt-space-2) 0;
    border-top: 1px solid var(--sfdt-color-bg);
  }
  label.row:first-of-type { border-top: 0; }
  label.row .label-text { flex: 1; }
  label.row .label-text strong { display: block; font-weight: 500; font: var(--sfdt-type-body-md); font-weight: 600; }
  label.row .label-text span { color: var(--sfdt-color-text-icon); font: var(--sfdt-type-body-sm); }

  input[type="text"], input[type="number"], select, input[type="password"] {
    border: 1px solid var(--sfdt-color-border);
    border-radius: var(--sfdt-radius);
    padding: 6px var(--sfdt-space-2);
    font: var(--sfdt-type-body-sm);
    min-width: 200px;
    background: var(--sfdt-color-surface);
    color: var(--sfdt-color-text);
  }
  input[type="text"]:focus-visible, input[type="number"]:focus-visible,
  select:focus-visible, input[type="password"]:focus-visible {
    outline: 2px solid var(--sfdt-color-info);
    outline-offset: 1px;
  }
  input[type="color"] {
    width: 36px; height: 28px;
    border: 1px solid var(--sfdt-color-border);
    border-radius: var(--sfdt-radius);
    padding: 0;
    cursor: pointer;
  }
  input[type="checkbox"] { transform: scale(1.1); cursor: pointer; accent-color: var(--sfdt-color-brand); }

  .actions { margin-top: var(--sfdt-space-3); display: flex; gap: var(--sfdt-space-2); align-items: center; }
  .shortcut-row { display: flex; gap: var(--sfdt-space-2); align-items: center; padding: 6px 0; }
  .shortcut-row input[type="text"] { flex: 1; min-width: 0; }

  /* Deliberately NOT .sfdt-pill: these are transient sentences ("Saved",
     "Cleared"), and the pill is an uppercase status badge — reusing it would
     shout SAVED at the user after every keystroke-free save. */
  .status {
    font: var(--sfdt-type-body-sm);
    padding: var(--sfdt-space-1) var(--sfdt-space-2);
    border-radius: var(--sfdt-radius);
    display: none;
    /* Multi-line org text: see the note above STYLES. */
    white-space: pre-line;
  }
  .status.show { display: inline-block; }
  .status.ok { background: var(--sfdt-color-success-bg); color: var(--sfdt-color-success-text); }
  .status.warn { background: var(--sfdt-color-warning-bg-6); color: var(--sfdt-color-warning-text); }
  .status.error { background: var(--sfdt-color-error-bg-4); color: var(--sfdt-color-error-text); }

  .hint {
    background: var(--sfdt-color-surface-shade);
    border-left: 3px solid var(--sfdt-color-brand);
    padding: var(--sfdt-space-2) var(--sfdt-space-3);
    font: var(--sfdt-type-body-sm);
    color: var(--sfdt-color-text-weak);
    margin: var(--sfdt-space-3) 0;
    border-radius: 0 var(--sfdt-radius) var(--sfdt-radius) 0;
  }
  .hint code {
    background: var(--sfdt-color-surface);
    border: 1px solid var(--sfdt-color-border);
    border-radius: var(--sfdt-radius-sm);
    padding: 1px var(--sfdt-space-1);
    font: var(--sfdt-type-code-sm);
  }
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string | number | boolean>> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === 'class') node.className = String(v);
    else if (typeof v === 'boolean') {
      if (v) node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return node;
}

function row(labelStrong: string, labelHelp: string, control: HTMLElement): HTMLLabelElement {
  const label = el('label', { class: 'row' });
  const text = el('div', { class: 'label-text' });
  const strong = el('strong');
  strong.textContent = labelStrong;
  const span = el('span');
  span.textContent = labelHelp;
  text.appendChild(strong);
  text.appendChild(span);
  label.appendChild(text);
  label.appendChild(control);
  return label;
}

// createElement-only — no innerHTML, the CSP hook rejects it.
function buildHintBanner(): HTMLDivElement {
  const hint = el('div', { class: 'hint' });
  const code1 = el('code');
  code1.textContent = '~/.sfdt/bridge-token';
  const code2 = el('code');
  code2.textContent = 'sfdt ui';
  hint.appendChild(document.createTextNode('Find your bridge token at '));
  hint.appendChild(code1);
  hint.appendChild(document.createTextNode(' after running '));
  hint.appendChild(code2);
  hint.appendChild(
    document.createTextNode(' once. The token is created automatically on first request.'),
  );
  return hint;
}

async function render(): Promise<void> {
  const root = document.getElementById('sfdt-options-root');
  if (!root) return;

  const styleTag = document.createElement('style');
  // Order matters: tokens define the custom properties the component sheet
  // consumes, and STYLES layers this page's own layout on top of both.
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${OWN_PAGE_COLOR_SCHEME_CSS}\n${SFDT_COMPONENT_CSS}\n${STYLES}`;
  document.head.appendChild(styleTag);
  const themeController = watchTheme(document);

  const registry = createFeatureRegistry();
  registry.register(createSetupTabsFeature());
  registry.register(createCanvasSearchFeature());
  registry.register(createFlowListSearchFeature());
  registry.register(createFlowHealthCheckFeature());
  registry.register(createMissingDescriptionFlagsFeature());
  registry.register(createFlowVersionManagerFeature());
  registry.register(createAiAssistantFeature());
  registry.register(createScheduledFlowExplorerFeature());
  registry.register(createApiNameGeneratorFeature());
  registry.register(createComparisonExporterFeature());
  registry.register(createFlowTriggerExplorerEnhancerFeature());
  registry.register(createTriggerConflictsFeature());
  registry.register(createSubflowGraphFeature());
  registry.register(createFlowDeployFeature());
  registry.register(createSoqlRunnerFeature());
  registry.register(createOrgLimitsFeature());
  registry.register(createRestExploreFeature());
  registry.register(createApexAnonymousFeature());
  registry.register(createDebugLogViewerFeature());
  registry.register(createSavedSoqlFeature());
  registry.register(createOrgSwitcherFeature());
  registry.register(createContextMenuInspectFeature());
  // Capability-only, and ships OFF: deleting a record is irreversible.
  registry.register(createRecordDeleteFeature());
  // C-P4-2. Metadata-only and OFF by default, so its row on this page carries
  // the "Off by default" pill and is the only way the SOQL runner's Delete
  // rows control ever appears.
  registry.register(createSoqlBulkDeleteFeature());
  // C-P4-5. Also OFF by default — it sends org schema through the bridge to an
  // AI provider — so its row carries the "Off by default" pill and ticking it
  // is the only way the runner's "Generate query" control is ever built.
  registry.register(createSoqlNlGenerateFeature());

  const settings = await loadSettings();
  while (root.firstChild) root.removeChild(root.firstChild);

  const wrap = el('div', { class: 'wrap' });

  // Bolt glyph beside the words, matching the Workspace app bar and the org
  // picker — the mark is an SVG on every surface now, not a pictograph baked
  // into a string on some of them.
  const title = el('h1');
  title.classList.add('sfdt-row');
  title.appendChild(icon('bolt', 26));
  const titleText = el('span');
  titleText.textContent = 'SFDT for Salesforce';
  title.appendChild(titleText);
  wrap.appendChild(title);

  const subtitle = el('p', { class: 'subtitle' });
  subtitle.textContent =
    'Settings sync to chrome.storage.local. Changes apply immediately — no reload needed.';
  wrap.appendChild(subtitle);

  // Two columns. The split is by WEIGHT, not by topic: the left column holds
  // the things you scroll and read (bridge setup, 44 feature toggles, every
  // per-feature schema), the right holds the short preference cards. A single
  // 720px column put nineteen cards in one stack, so the small ones — theme,
  // telemetry — sat below a very long list and were effectively unfindable.
  const bento = el('div', { class: 'sfdt-bento' });
  const mainCol = el('div', { class: 'sfdt-bento-col' });
  const sideCol = el('div', { class: 'sfdt-bento-col' });
  bento.append(mainCol, sideCol);
  wrap.appendChild(bento);

  const bridgeSection = el('section', { class: 'sfdt-card sfdt-card-section' });
  bridgeSection.appendChild(el('h2', {}, 'sfdt bridge'));
  const bridgeHelp = el('p', { class: 'section-help' });
  bridgeHelp.textContent =
    'Connects this extension to the sfdt CLI on your machine. Required for Flow Builder Deploy and the "Run via sfdt" path in the AI Assistant.';
  bridgeSection.appendChild(bridgeHelp);
  bridgeSection.appendChild(buildHintBanner());

  const tokenInput = el('input', {
    type: 'password',
    placeholder: 'Paste your bridge token',
  });
  tokenInput.value = settings.bridge.token;
  bridgeSection.appendChild(row('Bearer token', 'From ~/.sfdt/bridge-token on your machine.', tokenInput));

  const transportSelect = el('select');
  for (const [value, label] of [
    ['auto', 'Auto (try localhost, fall back to native)'],
    ['localhost', 'Localhost HTTP only (sfdt ui must be running)'],
    ['native', 'Native messaging host only'],
  ] as const) {
    const opt = el('option', { value });
    opt.textContent = label;
    if (settings.bridge.preferredTransport === value) opt.selected = true;
    transportSelect.appendChild(opt);
  }
  bridgeSection.appendChild(row('Preferred transport', 'How the extension reaches sfdt.', transportSelect));

  const portInput = el('input', { type: 'number', min: '1024', max: '65535' });
  portInput.value = String(settings.bridge.localhostPort);
  bridgeSection.appendChild(
    row('Localhost port', 'Default 7654 — match the port sfdt ui is on.', portInput),
  );

  const testButton = el('button', { class: 'sfdt-btn sfdt-primary' });
  testButton.textContent = 'Test connection';
  const testStatus = el('span', { class: 'status' });
  testButton.addEventListener('click', async () => {
    testStatus.className = 'status show';
    testStatus.textContent = 'Pinging…';
    const client = createBridgeClient({
      token: tokenInput.value,
      preferredTransport: transportSelect.value as Settings['bridge']['preferredTransport'],
      localhostPort: Number(portInput.value) || 7654,
    });
    const response = await client.call({ kind: 'ping' });
    if (response.ok) {
      const data = getBridgeData<{ serverVersion: string; transport: string }>(response);
      testStatus.className = 'status show ok';
      testStatus.textContent = `OK — sfdt v${data.serverVersion ?? '?'} via ${data.transport ?? '?'}`;
    } else {
      testStatus.className = 'status show error';
      testStatus.textContent = response.error;
    }
  });
  const actions = el('div', { class: 'actions' });
  actions.appendChild(testButton);
  actions.appendChild(testStatus);
  bridgeSection.appendChild(actions);
  mainCol.appendChild(bridgeSection);

  // --- Custom shortcuts (command palette) ---
  const shortcutsSection = el('section', { class: 'sfdt-card sfdt-card-section' });
  shortcutsSection.appendChild(el('h2', {}, 'Custom shortcuts'));
  const shortcutsHelp = el('p', { class: 'section-help' });
  shortcutsHelp.textContent =
    'Name/URL shortcuts that appear in the command palette (Ctrl/Cmd+Shift+K) under "Shortcuts". Selecting one opens its URL. Names must be unique and URLs must be valid.';
  shortcutsSection.appendChild(shortcutsHelp);

  const shortcutRows: Array<{ nameInput: HTMLInputElement; urlInput: HTMLInputElement }> = [];
  const shortcutList = el('div');
  shortcutsSection.appendChild(shortcutList);

  function addShortcutRow(name = '', url = ''): void {
    const nameInput = el('input', { type: 'text', placeholder: 'Name' });
    nameInput.value = name;
    nameInput.setAttribute('aria-label', 'Shortcut name');
    const urlInput = el('input', { type: 'text', placeholder: 'https://…' });
    urlInput.value = url;
    urlInput.setAttribute('aria-label', 'Shortcut URL');
    const removeBtn = el('button', {}, 'Remove');
    removeBtn.setAttribute('aria-label', 'Remove shortcut');
    const entry = { nameInput, urlInput };
    const rowEl = el('div', { class: 'shortcut-row' });
    rowEl.appendChild(nameInput);
    rowEl.appendChild(urlInput);
    rowEl.appendChild(removeBtn);
    removeBtn.addEventListener('click', () => {
      const i = shortcutRows.indexOf(entry);
      if (i >= 0) shortcutRows.splice(i, 1);
      rowEl.remove();
    });
    shortcutRows.push(entry);
    shortcutList.appendChild(rowEl);
  }

  for (const s of settings.customShortcuts ?? []) addShortcutRow(s.name, s.url);

  const addShortcutBtn = el('button', {}, 'Add shortcut');
  addShortcutBtn.addEventListener('click', () => addShortcutRow());
  const shortcutActions = el('div', { class: 'actions' });
  shortcutActions.appendChild(addShortcutBtn);
  shortcutsSection.appendChild(shortcutActions);
  sideCol.appendChild(shortcutsSection);

  // Collect + validate the shortcut rows for the shared Save handler. Throws with
  // a user-facing message on a duplicate name or a malformed URL (the caller's
  // try/catch surfaces it in the status pill). Blank rows are dropped.
  const collectShortcuts = (): Array<{ name: string; url: string }> =>
    validateCustomShortcuts(shortcutRows.map((r) => ({ name: r.nameInput.value, url: r.urlInput.value })));

  const featuresSection = el('section', { class: 'sfdt-card sfdt-card-section' });
  featuresSection.appendChild(el('h2', {}, 'Features'));
  const featuresHelp = el('p', { class: 'section-help' });
  featuresHelp.textContent =
    'Toggle individual features on or off. Disabled features never run, never show in the side menu.';
  featuresSection.appendChild(featuresHelp);

  interface FeatureRow {
    id: string;
    checkbox: HTMLInputElement;
  }
  const featureRows: FeatureRow[] = [];

  // Forty-four rows is a list you hunt through, not one you scan. The filter
  // matches the name AND the contexts, so "flow" finds the Flow tools and
  // "record_page" finds everything that runs on one.
  const featureFilter = el('input', {
    type: 'search',
    class: 'sfdt-field sfdt-search',
    placeholder: 'Filter features…',
    'aria-label': 'Filter features',
  }) as HTMLInputElement;
  const featureCount = el('p', { class: 'section-help' });
  featuresSection.append(featureFilter, featureCount);

  const manifests = registry.listManifests();
  const featureEls: Array<{ el: HTMLElement; haystack: string }> = [];

  for (const manifest of manifests) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = isFeatureEnabled(settings, manifest.id);
    const description = `${manifest.contexts.length} context(s): ${manifest.contexts.join(', ') || '—'}`;
    const rowEl = row(manifest.name, description, checkbox);

    // Badges from data the manifests ALREADY carry — not an invented maturity
    // scale. "Needs CLI" is the one that actually changes what a user should
    // expect, because those features are inert without `sfdt ui` running.
    const badges = el('span', { class: 'sfdt-row sfdt-tight' });
    if (BRIDGE_REQUIRED.has(manifest.id)) {
      const b = el('span', { class: 'sfdt-pill sfdt-warning' });
      b.textContent = 'Needs CLI';
      badges.appendChild(b);
    }
    if (manifest.enabledByDefault === false) {
      const b = el('span', { class: 'sfdt-pill' });
      b.textContent = 'Off by default';
      badges.appendChild(b);
    }
    if (badges.firstChild) rowEl.insertBefore(badges, rowEl.lastChild);

    featuresSection.appendChild(rowEl);
    featureRows.push({ id: manifest.id, checkbox });
    featureEls.push({
      el: rowEl,
      haystack: `${manifest.name} ${manifest.id} ${manifest.contexts.join(' ')}`.toLowerCase(),
    });
  }

  const applyFeatureFilter = (): void => {
    const term = featureFilter.value.trim().toLowerCase();
    let shown = 0;
    for (const f of featureEls) {
      const match = !term || f.haystack.includes(term);
      f.el.style.display = match ? '' : 'none';
      if (match) shown += 1;
    }
    // Say BOTH numbers while filtering: "12 features" alone reads as the total.
    featureCount.textContent =
      shown === featureEls.length
        ? `${featureEls.length} features`
        : `${shown} of ${featureEls.length} features`;
  };
  featureFilter.addEventListener('input', applyFeatureFilter);
  applyFeatureFilter();
  mainCol.appendChild(featuresSection);

  interface FeatureFieldGroup {
    id: string;
    getValues: () => Record<string, unknown>;
  }
  const featureFieldGroups: FeatureFieldGroup[] = [];

  for (const manifest of registry.listManifests()) {
    if (!manifest.settingsSchema) continue;
    const section = el('section', { class: 'sfdt-card sfdt-card-section' });
    section.appendChild(el('h2', {}, manifest.name));
    const help = el('p', { class: 'section-help' });
    help.textContent = `Feature-specific configuration for ${manifest.name}.`;
    section.appendChild(help);

    const schema = manifest.settingsSchema as z.ZodObject<z.ZodRawShape>;
    const initialBlock =
      (settings.featureSettings?.[manifest.id] as Record<string, unknown> | undefined) ??
      (schema.parse({}) as Record<string, unknown>);
    const shape = schema._def.shape();
    const fieldGetters: Record<string, () => unknown> = {};
    for (const [key, childSchema] of Object.entries(shape)) {
      const field = buildField<unknown>(childSchema as z.ZodTypeAny, initialBlock[key]);
      fieldGetters[key] = field.getValue;
      section.appendChild(row(key, '', field.node));
    }
    featureFieldGroups.push({
      id: manifest.id,
      getValues: () => {
        const out: Record<string, unknown> = {};
        for (const [k, getValue] of Object.entries(fieldGetters)) out[k] = getValue();
        return out;
      },
    });
    mainCol.appendChild(section);
  }

  const appearanceSection = el('section', { class: 'sfdt-card sfdt-card-section' });
  appearanceSection.appendChild(el('h2', {}, 'Appearance'));
  const appearanceHelp = el('p', { class: 'section-help' });
  appearanceHelp.textContent =
    'Theme for the extension UI (side menu, tools, options). Applies to every Salesforce tab and persists across restarts.';
  appearanceSection.appendChild(appearanceHelp);

  const themeSelect = el('select', { id: 'sfdt-theme-select' });
  themeSelect.setAttribute('aria-label', 'Theme');
  for (const [value, optLabel] of [
    ['auto', 'Auto (match your operating system)'],
    ['light', 'Light'],
    ['dark', 'Dark'],
  ] as const) {
    const opt = el('option', { value });
    opt.textContent = optLabel;
    if ((settings.theme ?? 'auto') === value) opt.selected = true;
    themeSelect.appendChild(opt);
  }
  // Live preview: route through the controller (not applyTheme directly) so the
  // OS-scheme listener tracks the previewed choice — an OS flip during an
  // unsaved preview keeps the preview, rather than reverting it. Persisted only
  // on Save (below).
  themeSelect.addEventListener('change', () => {
    themeController.setSetting(themeSelect.value as ThemeSetting);
  });
  appearanceSection.appendChild(row('Theme', 'Light, dark, or follow the OS.', themeSelect));

  // Default tool surface (P2-3 PR-2): where tools open by default. Default
  // 'modal' preserves the classic centered overlay, so nothing changes unless
  // opted in. Honoured today by the toolbar popup (promotes "Open side panel");
  // deep routing of an on-page tool into the open panel is a follow-up.
  const surfaceSelect = el('select', { id: 'sfdt-surface-select' });
  surfaceSelect.setAttribute('aria-label', 'Default tool surface');
  for (const [value, optLabel] of [
    ['modal', 'Centered modal (classic)'],
    ['panel', 'Docked side panel'],
  ] as const) {
    const opt = el('option', { value });
    opt.textContent = optLabel;
    if ((settings.defaultSurface ?? 'modal') === value) opt.selected = true;
    surfaceSelect.appendChild(opt);
  }
  appearanceSection.appendChild(
    row(
      'Default tool surface',
      'Where tools prefer to open (Chrome side panel or the classic modal).',
      surfaceSelect,
    ),
  );
  sideCol.appendChild(appearanceSection);

  const activitySection = el('section', { class: 'sfdt-card sfdt-card-section' });
  activitySection.appendChild(el('h2', {}, 'Activity log'));
  const activityHelp = el('p', { class: 'section-help' });
  activityHelp.textContent =
    'The Workspace Overview shows the last 100 things you ran. Stored in this browser profile only — never synced, never transmitted. Unlike telemetry it can include Salesforce data: the first 120 characters of a SOQL statement or the name of a class you deployed. Turn it off if that data should not be written to disk.';
  activitySection.appendChild(activityHelp);

  const activityCb = el('input', { type: 'checkbox' });
  activityCb.checked = settings.activityLog?.enabled ?? true;
  activitySection.appendChild(
    row('Record recent activity', 'On by default. Clear the log from the Overview panel.', activityCb),
  );

  const clearActivityBtn = el('button', { class: 'sfdt-btn' });
  clearActivityBtn.textContent = 'Clear activity log now';
  const clearActivityStatus = el('span', { class: 'status' });
  clearActivityBtn.addEventListener('click', async () => {
    await clearActivity();
    clearActivityStatus.className = 'status show ok';
    clearActivityStatus.textContent = 'Cleared';
    setTimeout(() => {
      clearActivityStatus.className = 'status';
    }, 2000);
  });
  const clearActivityRow = el('div', { class: 'actions' });
  clearActivityRow.appendChild(clearActivityBtn);
  clearActivityRow.appendChild(clearActivityStatus);
  activitySection.appendChild(clearActivityRow);
  sideCol.appendChild(activitySection);

  const telemetrySection = el('section', { class: 'sfdt-card sfdt-card-section' });
  telemetrySection.appendChild(el('h2', {}, 'Telemetry'));
  const telemetryHelp = el('p', { class: 'section-help' });
  telemetryHelp.textContent =
    'When enabled, the extension counts feature activations and errors locally so you can see which features you actually use. No data leaves this browser profile.';
  telemetrySection.appendChild(telemetryHelp);

  const telemetryCb = el('input', { type: 'checkbox' });
  telemetryCb.checked = settings.telemetry?.enabled ?? false;
  telemetrySection.appendChild(
    row('Enable local telemetry', 'Off by default. Toggle on to start counting.', telemetryCb),
  );

  const telemetry = createTelemetry({ isEnabled: () => settings.telemetry?.enabled ?? false });
  const snapshot = await telemetry.snapshot();
  const ids = Object.keys(snapshot.counters).sort(
    (a, b) => (snapshot.counters[b]?.activated ?? 0) - (snapshot.counters[a]?.activated ?? 0),
  );
  if (ids.length > 0) {
    const tableLabel = el('p', { class: 'section-help' });
    tableLabel.textContent = `Counters for ${snapshot.monthKey}:`;
    telemetrySection.appendChild(tableLabel);
    for (const id of ids.slice(0, 10)) {
      const c = snapshot.counters[id];
      if (!c) continue;
      const line = el('div');
      line.classList.add('sfdt-kv');
      line.textContent = `${id} — activated ${c.activated}, errors ${c.errored}, remote-disabled ${c.disabled_remote}`;
      telemetrySection.appendChild(line);
    }
  }
  sideCol.appendChild(telemetrySection);

  // Best-effort push of the current telemetry snapshot to the bridge so
  // `sfdt extension stats` has fresh data. Only fires when telemetry is
  // opted in, never blocks the options page, never throws into the UI.
  if (telemetryCb.checked) {
    void (async () => {
      try {
        const client = createBridgeClient({
          token: tokenInput.value,
          preferredTransport: transportSelect.value as Settings['bridge']['preferredTransport'],
          localhostPort: Number(portInput.value) || 7654,
        });
        await telemetry.pushSnapshot(async (snap) => {
          const res = await client.call({
            kind: 'telemetry.snapshot',
            monthKey: snap.monthKey,
            counters: snap.counters,
          });
          return !!res.ok;
        });
      } catch {
        // Snapshot push is best-effort. Failures are invisible to the user.
      }
    })();
  }

  // Pinned, not a card at the end of the page. With nineteen sections above it
  // you had to scroll past all of them to commit a toggle made at the top —
  // the same "action scrolled out of reach" problem the SOQL runner and the
  // data importer had.
  const saveBar = el('div', { class: 'sfdt-savebar' });
  const saveBtn = el('button', { class: 'sfdt-btn sfdt-primary' });
  saveBtn.textContent = 'Save changes';
  const saveStatus = el('span', { class: 'status' });
  saveBtn.addEventListener('click', async () => {
    try {
      const features: Record<string, boolean> = { ...settings.features };
      for (const r of featureRows) features[r.id] = r.checkbox.checked;

      const featureSettings: Record<string, unknown> = { ...(settings.featureSettings ?? {}) };
      for (const group of featureFieldGroups) {
        featureSettings[group.id] = group.getValues();
      }

      const customShortcuts = collectShortcuts();

      const portValue = Number(portInput.value);
      const next: Partial<Settings> = {
        features,
        featureSettings: featureSettings as Settings['featureSettings'],
        customShortcuts,
        bridge: {
          token: tokenInput.value.trim(),
          preferredTransport: transportSelect.value as Settings['bridge']['preferredTransport'],
          localhostPort: Number.isFinite(portValue) && portValue > 0 ? portValue : 7654,
        },
        telemetry: { enabled: telemetryCb.checked },
        activityLog: { enabled: activityCb.checked },
        theme: themeSelect.value as ThemeSetting,
        defaultSurface: surfaceSelect.value as Settings['defaultSurface'],
      };
      await patchSettings(next as Settings);
      saveStatus.className = 'status show ok';
      saveStatus.textContent = 'Saved';
      setTimeout(() => {
        saveStatus.className = 'status';
      }, 2000);
    } catch (err) {
      saveStatus.className = 'status show error';
      saveStatus.textContent = err instanceof Error ? err.message : String(err);
    }
  });
  const saveActions = el('div', { class: 'actions' });
  saveActions.appendChild(saveBtn);
  saveActions.appendChild(saveStatus);
  saveBar.appendChild(saveActions);
  root.appendChild(wrap);
  // Outside .wrap so it spans the window rather than the 1100px content column.
  root.appendChild(saveBar);
}

void render();
