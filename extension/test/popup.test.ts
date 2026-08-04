import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  loadPopupState,
  renderPopup,
  type PopupDeps,
  type PopupState,
} from '../lib/popup.js';

const SF_URL = 'https://acme.lightning.force.com/lightning/setup/SetupOneHome/home';
const CANONICAL = 'acme.my.salesforce.com';

function deps(over: Partial<PopupDeps> = {}): PopupDeps {
  return {
    activeTabUrl: SF_URL,
    hasSidePanel: true,
    defaultSurface: 'modal',
    version: '0.7.0',
    listLoggedInHosts: vi.fn(async () => [CANONICAL]),
    pingBridge: vi.fn(async () => true),
    ...over,
  };
}

describe('loadPopupState', () => {
  it('detects a Salesforce tab and reports an active session + connected bridge', async () => {
    const state = await loadPopupState(deps());
    expect(state).toEqual({
      isSalesforceTab: true,
      hasSidePanel: true,
      orgHost: 'acme.lightning.force.com',
      session: 'active',
      bridge: 'connected',
      defaultSurface: 'modal',
      version: '0.7.0',
    });
  });

  it('reports logged-out when the tab org is not among the logged-in orgs', async () => {
    const state = await loadPopupState(deps({ listLoggedInHosts: vi.fn(async () => ['other.my.salesforce.com']) }));
    expect(state.session).toBe('logged-out');
  });

  it('reports a disconnected bridge when the ping fails', async () => {
    const state = await loadPopupState(deps({ pingBridge: vi.fn(async () => false) }));
    expect(state.bridge).toBe('disconnected');
  });

  it('degrades gracefully when the status lookups reject', async () => {
    const state = await loadPopupState(
      deps({
        listLoggedInHosts: vi.fn(async () => {
          throw new Error('worker down');
        }),
        pingBridge: vi.fn(async () => {
          throw new Error('worker down');
        }),
      }),
    );
    expect(state.session).toBe('logged-out');
    expect(state.bridge).toBe('disconnected');
  });

  it('on a non-Salesforce tab, returns the empty state and makes ZERO API calls', async () => {
    const listLoggedInHosts = vi.fn(async () => [CANONICAL]);
    const pingBridge = vi.fn(async () => true);
    const state = await loadPopupState(
      deps({ activeTabUrl: 'https://example.com/', listLoggedInHosts, pingBridge }),
    );
    expect(state).toEqual({
      isSalesforceTab: false,
      hasSidePanel: true,
      orgHost: null,
      session: null,
      bridge: null,
      defaultSurface: 'modal',
      version: '0.7.0',
    });
    expect(listLoggedInHosts).not.toHaveBeenCalled();
    expect(pingBridge).not.toHaveBeenCalled();
  });

  it('treats an undefined active tab URL as non-Salesforce (no API calls)', async () => {
    const listLoggedInHosts = vi.fn(async () => [CANONICAL]);
    const state = await loadPopupState(deps({ activeTabUrl: undefined, listLoggedInHosts }));
    expect(state.isSalesforceTab).toBe(false);
    expect(listLoggedInHosts).not.toHaveBeenCalled();
  });
});

describe('renderPopup', () => {
  const handlers = {
    onOpenWorkspace: vi.fn(),
    onOpenPanel: vi.fn(),
    onOpenPalette: vi.fn(),
    onOpenOptions: vi.fn(),
  };

  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    const div = document.createElement('div');
    div.id = 'root';
    document.body.appendChild(div);
    vi.clearAllMocks();
  });

  function root(): HTMLElement {
    return document.getElementById('root') as HTMLElement;
  }

  it('renders org + status rows + all buttons for a Salesforce tab', () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: true,
        orgHost: 'acme.lightning.force.com',
        session: 'active',
        bridge: 'connected',
        defaultSurface: 'modal',
        version: '0.7.0',
      },
      handlers,
    );
    const text = root().textContent ?? '';
    expect(text).toContain('acme.lightning.force.com');
    expect(text).toContain('Session');
    expect(text).toContain('signed in');
    expect(text).toContain('sfdt bridge');
    expect(text).toContain('v0.7.0');
    const labels = Array.from(root().querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Open Workspace', 'Open side panel', 'Quick menu', 'Settings']);
  });

  it('renders the "not a Salesforce tab" state and hides the Quick menu button', () => {
    renderPopup(
      root(),
      { isSalesforceTab: false, hasSidePanel: true, orgHost: null, session: null, bridge: null, defaultSurface: 'modal', version: '0.7.0' },
      handlers,
    );
    expect(root().textContent).toContain('Not a Salesforce tab');
    const labels = Array.from(root().querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Open Workspace', 'Open side panel', 'Settings']);
  });

  it('status is conveyed by text, not colour alone (a11y): dots are aria-hidden', () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: true,
        orgHost: 'acme.lightning.force.com',
        session: 'logged-out',
        bridge: 'disconnected',
        defaultSurface: 'modal',
        version: '0.7.0',
      },
      handlers,
    );
    const dots = root().querySelectorAll('.sfdt-popup-dot');
    expect(dots.length).toBe(2);
    dots.forEach((d) => expect(d.getAttribute('aria-hidden')).toBe('true'));
    // Every status row carries a role and a readable value.
    const rows = root().querySelectorAll('[role="status"]');
    expect(rows.length).toBe(2);
    expect(root().textContent).toContain('not signed in');
    expect(root().textContent).toContain('not running');
  });

  it('wires buttons to their handlers with real <button> elements (keyboard-reachable)', () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: true,
        orgHost: 'acme.lightning.force.com',
        session: 'active',
        bridge: 'connected',
        defaultSurface: 'modal',
        version: '0.7.0',
      },
      handlers,
    );
    const buttons = Array.from(root().querySelectorAll('button'));
    buttons.forEach((b) => expect(b.tagName).toBe('BUTTON'));
    buttons.find((b) => b.textContent === 'Open Workspace')?.click();
    buttons.find((b) => b.textContent === 'Open side panel')?.click();
    buttons.find((b) => b.textContent === 'Quick menu')?.click();
    buttons.find((b) => b.textContent === 'Settings')?.click();
    expect(handlers.onOpenWorkspace).toHaveBeenCalledOnce();
    expect(handlers.onOpenPanel).toHaveBeenCalledOnce();
    expect(handlers.onOpenPalette).toHaveBeenCalledOnce();
    expect(handlers.onOpenOptions).toHaveBeenCalledOnce();
  });

  it('hides the "Open side panel" button when chrome.sidePanel is absent (Firefox)', () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: false,
        orgHost: 'acme.lightning.force.com',
        session: 'active',
        bridge: 'connected',
        defaultSurface: 'modal',
        version: '0.7.0',
      },
      handlers,
    );
    const labels = Array.from(root().querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).not.toContain('Open side panel');
    expect(labels).toEqual(['Open Workspace', 'Quick menu', 'Settings']);
  });

  it("promotes 'Open side panel' to the primary/first action when defaultSurface is 'panel' (C)", () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: true,
        orgHost: 'acme.lightning.force.com',
        session: 'active',
        bridge: 'connected',
        defaultSurface: 'panel',
        version: '0.7.0',
      },
      handlers,
    );
    const buttons = Array.from(root().querySelectorAll('button'));
    const labels = buttons.map((b) => b.textContent);
    // Side panel now leads; it's the primary button.
    expect(labels).toEqual(['Open side panel', 'Open Workspace', 'Quick menu', 'Settings']);
    expect(buttons[0]?.classList.contains('primary')).toBe(true);
    expect(buttons[1]?.classList.contains('primary')).toBe(false);
  });

  it("ignores the 'panel' preference on Firefox (no chrome.sidePanel) — Workspace still leads", () => {
    renderPopup(
      root(),
      {
        isSalesforceTab: true,
        hasSidePanel: false,
        orgHost: 'acme.lightning.force.com',
        session: 'active',
        bridge: 'connected',
        defaultSurface: 'panel',
        version: '0.7.0',
      },
      handlers,
    );
    const labels = Array.from(root().querySelectorAll('button')).map((b) => b.textContent);
    expect(labels).toEqual(['Open Workspace', 'Quick menu', 'Settings']);
  });

  it('has a single heading for the popup (a11y landmark)', () => {
    renderPopup(
      root(),
      { isSalesforceTab: false, hasSidePanel: true, orgHost: null, session: null, bridge: null, defaultSurface: 'modal', version: '0.7.0' },
      handlers,
    );
    const headings = root().querySelectorAll('h1');
    expect(headings.length).toBe(1);
  });

  // The popup was rebuilt onto lib/ui-styles + lib/icons: a command list with a
  // pinned footer, instead of four full-width bordered buttons that read as a
  // form. These pin the structure the shared sheet styles.
  describe('shared component layer', () => {
    function render(over: Partial<PopupState> = {}): void {
      renderPopup(
        root(),
        {
          isSalesforceTab: true,
          hasSidePanel: true,
          orgHost: 'acme.lightning.force.com',
          session: 'active',
          bridge: 'connected',
          defaultSurface: 'modal',
          version: '0.7.0',
          ...over,
        },
        handlers,
      );
    }

    it('builds actions as shared nav-item rows, not bespoke popup buttons', () => {
      render();
      const actions = root().querySelectorAll('.sfdt-popup-actions button');
      expect(actions.length).toBeGreaterThan(0);
      for (const b of actions) expect(b.classList.contains('sfdt-nav-item')).toBe(true);
    });

    it('gives every action a decorative inline-SVG icon', () => {
      render();
      for (const b of root().querySelectorAll('.sfdt-popup-actions button')) {
        const svg = b.querySelector('svg');
        expect(svg).not.toBeNull();
        // Decorative: the label carries the meaning, so the glyph is hidden from
        // assistive tech rather than read out as a second, redundant name.
        expect(b.querySelector('.sfdt-glyph')?.getAttribute('aria-hidden')).toBe('true');
        expect(svg?.getAttribute('stroke')).toBe('currentColor');
      }
    });

    it('pins Settings and the version into a footer, out of the action list', () => {
      render();
      const foot = root().querySelector('.sfdt-popup-foot');
      expect(foot).not.toBeNull();
      expect(foot?.querySelector('.sfdt-popup-version')?.textContent).toBe('v0.7.0');
      expect(foot?.querySelector('button')?.textContent).toBe('Settings');
      // Settings must not also appear in the main list.
      const listLabels = Array.from(
        root().querySelectorAll('.sfdt-popup-actions button'),
      ).map((b) => b.textContent);
      expect(listLabels).not.toContain('Settings');
    });

    it('keeps the status dots decorative with the meaning in text (a11y)', () => {
      render();
      for (const dot of root().querySelectorAll('.sfdt-popup-dot')) {
        expect(dot.getAttribute('aria-hidden')).toBe('true');
      }
      expect(root().querySelector('.sfdt-popup-body')?.textContent).toContain('signed in');
    });

    it('still renders a footer on a non-Salesforce tab', () => {
      render({ isSalesforceTab: false, orgHost: null, session: null, bridge: null });
      expect(root().querySelector('.sfdt-popup-foot .sfdt-popup-version')?.textContent).toBe(
        'v0.7.0',
      );
    });
  });
});
