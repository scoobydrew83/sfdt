import { z } from 'zod';
import {
  isFeatureEnabled,
  loadSettings,
  patchSettings,
  type Settings,
} from '../../lib/settings.js';
import { createBridgeClient, getBridgeData } from '../../lib/sfdt-bridge.js';
import { createFeatureRegistry } from '../../lib/feature-registry.js';
import { buildField } from '../../lib/zod-to-dom.js';
import { createTelemetry } from '../../lib/telemetry.js';
import { SFDT_TOKENS_CSS } from '../../lib/tokens.js';

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


const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: var(--sfdt-color-surface-alt);
    color: var(--sfdt-color-brand-deep);
    margin: 0;
    padding: 32px 24px;
  }
  .wrap { max-width: 720px; margin: 0 auto; }
  h1 {
    font-size: 22px;
    margin: 0 0 4px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .subtitle { color: var(--sfdt-color-text-weak); font-size: 13px; margin: 0 0 24px; }
  section {
    background: var(--sfdt-color-surface);
    border: 1px solid var(--sfdt-color-border);
    border-radius: 4px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  section h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  section p.section-help { color: var(--sfdt-color-text-weak); font-size: 12px; margin: 0 0 12px; }
  label.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid var(--sfdt-color-bg);
  }
  label.row:first-of-type { border-top: 0; }
  label.row .label-text { flex: 1; }
  label.row .label-text strong { display: block; font-weight: 500; font-size: 13px; }
  label.row .label-text span { color: var(--sfdt-color-text-icon); font-size: 12px; }
  input[type="text"], input[type="number"], select, input[type="password"] {
    border: 1px solid var(--sfdt-color-border);
    border-radius: 3px;
    padding: 6px 8px;
    font-size: 13px;
    font-family: inherit;
    min-width: 200px;
  }
  input[type="color"] {
    width: 36px; height: 28px;
    border: 1px solid var(--sfdt-color-border);
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
  }
  input[type="checkbox"] { transform: scale(1.1); cursor: pointer; }
  button {
    padding: 6px 14px;
    border-radius: 3px;
    border: 1px solid var(--sfdt-color-border);
    background: var(--sfdt-color-surface);
    color: var(--sfdt-color-brand-deep);
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
  }
  button.primary { background: var(--sfdt-color-brand); color: var(--sfdt-color-surface); border-color: var(--sfdt-color-brand); }
  button:hover { background: var(--sfdt-color-bg); }
  button.primary:hover { background: var(--sfdt-color-brand-active); }
  .actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
  .status {
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 3px;
    display: none;
  }
  .status.show { display: inline-block; }
  .status.ok { background: var(--sfdt-color-success-bg); color: var(--sfdt-color-success); }
  .status.warn { background: var(--sfdt-color-warning-bg-6); color: var(--sfdt-color-warning-text); }
  .status.error { background: var(--sfdt-color-error-bg-4); color: var(--sfdt-color-error); }
  .hint {
    background: var(--sfdt-color-surface-shade);
    border-left: 3px solid var(--sfdt-color-brand);
    padding: 8px 12px;
    font-size: 12px;
    color: var(--sfdt-color-text-weak);
    margin: 12px 0;
    border-radius: 0 3px 3px 0;
  }
  .hint code {
    background: var(--sfdt-color-surface);
    border: 1px solid var(--sfdt-color-border);
    border-radius: 2px;
    padding: 1px 4px;
    font-family: ui-monospace, monospace;
    font-size: 11px;
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
  styleTag.textContent = `${SFDT_TOKENS_CSS}\n${STYLES}`;
  document.head.appendChild(styleTag);

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

  const settings = await loadSettings();
  while (root.firstChild) root.removeChild(root.firstChild);

  const wrap = el('div', { class: 'wrap' });

  const title = el('h1');
  title.textContent = '⚡ SFDT SF Helper';
  wrap.appendChild(title);

  const subtitle = el('p', { class: 'subtitle' });
  subtitle.textContent =
    'Settings sync to chrome.storage.local. Changes apply immediately — no reload needed.';
  wrap.appendChild(subtitle);

  const bridgeSection = el('section');
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

  const testButton = el('button', { class: 'primary' });
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
  wrap.appendChild(bridgeSection);

  const featuresSection = el('section');
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

  for (const manifest of registry.listManifests()) {
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = isFeatureEnabled(settings, manifest.id);
    const description = `${manifest.contexts.length} context(s): ${manifest.contexts.join(', ') || '—'}`;
    featuresSection.appendChild(row(manifest.name, description, checkbox));
    featureRows.push({ id: manifest.id, checkbox });
  }
  wrap.appendChild(featuresSection);

  interface FeatureFieldGroup {
    id: string;
    getValues: () => Record<string, unknown>;
  }
  const featureFieldGroups: FeatureFieldGroup[] = [];

  for (const manifest of registry.listManifests()) {
    if (!manifest.settingsSchema) continue;
    const section = el('section');
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
    wrap.appendChild(section);
  }

  const telemetrySection = el('section');
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
      line.style.fontSize = '12px';
      line.style.padding = '2px 0';
      line.textContent = `${id} — activated ${c.activated}, errors ${c.errored}, remote-disabled ${c.disabled_remote}`;
      telemetrySection.appendChild(line);
    }
  }
  wrap.appendChild(telemetrySection);

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

  const saveBar = el('section');
  const saveBtn = el('button', { class: 'primary' });
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

      const portValue = Number(portInput.value);
      const next: Partial<Settings> = {
        features,
        featureSettings: featureSettings as Settings['featureSettings'],
        bridge: {
          token: tokenInput.value.trim(),
          preferredTransport: transportSelect.value as Settings['bridge']['preferredTransport'],
          localhostPort: Number.isFinite(portValue) && portValue > 0 ? portValue : 7654,
        },
        telemetry: { enabled: telemetryCb.checked },
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
  wrap.appendChild(saveBar);

  root.appendChild(wrap);
}

void render();
