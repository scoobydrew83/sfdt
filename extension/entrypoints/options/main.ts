// Extension options page — vanilla DOM, no framework. Mounts at
// chrome-extension://<id>/options.html (WXT auto-generates the
// options_page manifest entry for any entrypoints/options/index.html).
//
// Mirrors the settings model in extension/lib/settings.ts byte-for-byte.
// Every change writes back through the same patchSettings() path, so
// the content scripts pick up changes via the chrome.storage.onChanged
// subscription they already have.

import {
  loadSettings,
  patchSettings,
  type Settings,
} from '../../lib/settings.js';
import { createBridgeClient } from '../../lib/sfdt-bridge.js';

const STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #fafaf9;
    color: #16325c;
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
  .subtitle { color: #54698d; font-size: 13px; margin: 0 0 24px; }
  section {
    background: #fff;
    border: 1px solid #d8dde6;
    border-radius: 4px;
    padding: 16px 20px;
    margin-bottom: 16px;
  }
  section h2 { font-size: 15px; margin: 0 0 4px; font-weight: 600; }
  section p.section-help { color: #54698d; font-size: 12px; margin: 0 0 12px; }
  label.row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 8px 0;
    border-top: 1px solid #f3f3f3;
  }
  label.row:first-of-type { border-top: 0; }
  label.row .label-text { flex: 1; }
  label.row .label-text strong { display: block; font-weight: 500; font-size: 13px; }
  label.row .label-text span { color: #80868d; font-size: 12px; }
  input[type="text"], input[type="number"], select, input[type="password"] {
    border: 1px solid #d8dde6;
    border-radius: 3px;
    padding: 6px 8px;
    font-size: 13px;
    font-family: inherit;
    min-width: 200px;
  }
  input[type="color"] {
    width: 36px; height: 28px;
    border: 1px solid #d8dde6;
    border-radius: 3px;
    padding: 0;
    cursor: pointer;
  }
  input[type="checkbox"] { transform: scale(1.1); cursor: pointer; }
  button {
    padding: 6px 14px;
    border-radius: 3px;
    border: 1px solid #d8dde6;
    background: #fff;
    color: #16325c;
    cursor: pointer;
    font-size: 13px;
    font-family: inherit;
  }
  button.primary { background: #0070d2; color: #fff; border-color: #0070d2; }
  button:hover { background: #f3f3f3; }
  button.primary:hover { background: #005fb2; }
  .actions { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
  .status {
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 3px;
    display: none;
  }
  .status.show { display: inline-block; }
  .status.ok { background: #ddf3e4; color: #04844b; }
  .status.warn { background: #fef1e1; color: #b46600; }
  .status.error { background: #fde2e0; color: #c23934; }
  .hint {
    background: #f4f6f9;
    border-left: 3px solid #0070d2;
    padding: 8px 12px;
    font-size: 12px;
    color: #54698d;
    margin: 12px 0;
    border-radius: 0 3px 3px 0;
  }
  .hint code {
    background: #fff;
    border: 1px solid #d8dde6;
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

/**
 * Build the hint banner ("Find your bridge token at ~/.sfdt/bridge-token…")
 * with createElement so the hook stays happy — we have inline <code>
 * sections, just no innerHTML.
 */
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
  const root = document.getElementById('sfut-options-root');
  if (!root) return;

  // Inject styles once.
  const styleTag = document.createElement('style');
  styleTag.textContent = STYLES;
  document.head.appendChild(styleTag);

  const settings = await loadSettings();
  while (root.firstChild) root.removeChild(root.firstChild);

  const wrap = el('div', { class: 'wrap' });

  const title = el('h1');
  title.textContent = '⚡ SF Flow Utility Toolkit';
  wrap.appendChild(title);

  const subtitle = el('p', { class: 'subtitle' });
  subtitle.textContent =
    'Settings sync to chrome.storage.local. Changes apply immediately — no reload needed.';
  wrap.appendChild(subtitle);

  // ─── Bridge section ───────────────────────────────────────────────────
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
      const data = response.data as { serverVersion?: string; transport?: string };
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

  // ─── Per-feature auto-run ────────────────────────────────────────────
  const featuresSection = el('section');
  featuresSection.appendChild(el('h2', {}, 'Auto-run features'));
  const featuresHelp = el('p', { class: 'section-help' });
  featuresHelp.textContent =
    'Features that run at page load are gated by these flags. Other features run on demand from the side menu regardless.';
  featuresSection.appendChild(featuresHelp);

  const featureToggles: Array<[keyof Settings['features'], string, string]> = [
    ['setupTabs', 'Setup Tabs', 'Inject Flows / Flow Trigger Explorer / Process Automation Settings into the Setup tab bar.'],
    ['missingDescriptions', 'Missing Description Flags', 'Auto-flag elements + resources without descriptions when Flow Builder loads.'],
    ['scheduledFlowExplorer', 'Scheduled Flow Explorer', 'Make the Scheduled Flow Explorer entry available from the side menu.'],
  ];
  const featureRows: Array<{ key: keyof Settings['features']; checkbox: HTMLInputElement }> = [];
  for (const [key, label, help] of featureToggles) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!settings.features[key];
    featuresSection.appendChild(row(label, help, cb));
    featureRows.push({ key, checkbox: cb });
  }
  wrap.appendChild(featuresSection);

  // ─── Setup Tabs sub-options ─────────────────────────────────────────
  const setupTabsSection = el('section');
  setupTabsSection.appendChild(el('h2', {}, 'Setup Tabs'));
  const setupHelp = el('p', { class: 'section-help' });
  setupHelp.textContent = 'Controls injected tabs. Master toggle is in the section above.';
  setupTabsSection.appendChild(setupHelp);
  const automationHomeCb = el('input', { type: 'checkbox' });
  automationHomeCb.checked = settings.setupTabs.automationHomeEnabled;
  setupTabsSection.appendChild(
    row(
      'Automation Home tab',
      'Adds a tab linking to the Automation Lightning app (standard__FlowsApp).',
      automationHomeCb,
    ),
  );
  const groupingCb = el('input', { type: 'checkbox' });
  groupingCb.checked = settings.setupTabs.groupingEnabled;
  setupTabsSection.appendChild(
    row(
      'Group under one dropdown',
      'Collapses the three tabs into a single Automation menu.',
      groupingCb,
    ),
  );
  wrap.appendChild(setupTabsSection);

  // ─── Canvas search ─────────────────────────────────────────────────
  const canvasSection = el('section');
  canvasSection.appendChild(el('h2', {}, 'Canvas search'));
  const shortcutInput = el('input', { type: 'text', placeholder: 'Ctrl+Shift+F' });
  shortcutInput.value = settings.canvasSearch.shortcut;
  canvasSection.appendChild(
    row(
      'Keyboard shortcut',
      'Modifier+key combo to open the canvas search bar in Flow Builder.',
      shortcutInput,
    ),
  );
  const colorInput = el('input', { type: 'color' });
  colorInput.value = settings.canvasSearch.highlightColour;
  canvasSection.appendChild(
    row(
      'Highlight colour',
      'Colour of the box-shadow ring around matching canvas elements.',
      colorInput,
    ),
  );
  wrap.appendChild(canvasSection);

  // ─── API name generator ───────────────────────────────────────────
  const apiNameSection = el('section');
  apiNameSection.appendChild(el('h2', {}, 'API Name Generator'));
  const patternSelect = el('select');
  for (const value of ['Snake_Case', 'PascalCase', 'camelCase'] as const) {
    const opt = el('option', { value });
    opt.textContent = value;
    if (settings.apiNameGenerator.namingPattern === value) opt.selected = true;
    patternSelect.appendChild(opt);
  }
  apiNameSection.appendChild(
    row(
      'Default naming pattern',
      'Default case used by the API Name Generator modal.',
      patternSelect,
    ),
  );
  wrap.appendChild(apiNameSection);

  // ─── Save bar ──────────────────────────────────────────────────────
  const saveBar = el('section');
  const saveBtn = el('button', { class: 'primary' });
  saveBtn.textContent = 'Save changes';
  const saveStatus = el('span', { class: 'status' });
  saveBtn.addEventListener('click', async () => {
    try {
      const features: Settings['features'] = { ...settings.features };
      for (const { key, checkbox } of featureRows) features[key] = checkbox.checked;
      const portValue = Number(portInput.value);
      const next: Partial<Settings> = {
        features,
        bridge: {
          token: tokenInput.value.trim(),
          preferredTransport: transportSelect.value as Settings['bridge']['preferredTransport'],
          localhostPort: Number.isFinite(portValue) && portValue > 0 ? portValue : 7654,
        },
        setupTabs: {
          automationHomeEnabled: automationHomeCb.checked,
          groupingEnabled: groupingCb.checked,
        },
        canvasSearch: {
          shortcut: shortcutInput.value.trim() || 'Ctrl+Shift+F',
          highlightColour: colorInput.value,
        },
        apiNameGenerator: {
          namingPattern: patternSelect.value as Settings['apiNameGenerator']['namingPattern'],
        },
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
