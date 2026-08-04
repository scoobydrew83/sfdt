// Unit tests for the shared host boot used by both the Workspace tab and the
// docked side panel (ui/workspace-host.ts). Covers the pure derivations and the
// happy-dom boot: feature registration into the host and the present-view sink
// wiring (tools render into panes, not dismissible modals).

import { describe, it, expect, beforeEach } from 'vitest';
import {
  orgOriginFor,
  isAllowedSfHost,
  makeSyntheticWin,
  bootHost,
  formatReleaseBadge,
} from '../ui/workspace-host.js';
import { inWorkspace, setWorkspaceViewSink } from '../ui/present-view.js';
import { FEATURE_ICONS, WORKSPACE_TOOLS, WORKSPACE_PRIMARY } from '../lib/feature-icons.js';
import type { ActivityEntry } from '../lib/activity-log.js';

/**
 * Let the async fills (recents, activity) settle. They're deliberately fired
 * without await from a synchronous bootHost, so a plain microtask tick isn't
 * always enough — a macrotask turn is.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('orgOriginFor', () => {
  it('derives the Lightning origin from a my.salesforce.com host', () => {
    expect(orgOriginFor('acme.my.salesforce.com')).toBe('https://acme.lightning.force.com');
  });
  it('is idempotent for a lightning host', () => {
    expect(orgOriginFor('acme.lightning.force.com')).toBe('https://acme.lightning.force.com');
  });
});

describe('isAllowedSfHost', () => {
  it.each([
    'acme.lightning.force.com',
    'acme.my.salesforce.com',
    'acme.salesforce-setup.com',
  ])('accepts %s', (host) => {
    expect(isAllowedSfHost(host)).toBe(true);
  });
  it.each(['example.com', 'evil.salesforce.com.attacker.net', ''])(
    'rejects %s',
    (host) => {
      expect(isAllowedSfHost(host)).toBe(false);
    },
  );
});

describe('makeSyntheticWin', () => {
  it('reads brand-checked accessors without an Illegal invocation', () => {
    // The real defect: `scrollY`, `innerWidth`, `scrollX`, `innerHeight` are
    // WebIDL accessors on Window.prototype. Forwarding the PROXY as receiver ran
    // those getters with `this` = proxy, which Chrome rejects with
    // "TypeError: Illegal invocation" — so opening the SOQL runner's record-Id
    // menu (which reads win.scrollY to position itself) threw, and the click
    // died silently.
    //
    // happy-dom exposes these as plain data properties, which is precisely why
    // every unit test passed while the Workspace was broken. So simulate the
    // browser: an accessor that throws unless `this` is the real target.
    const realWindow = window as unknown as Record<string, unknown>;
    const BRANDED = '__sfdtBrandChecked';
    Object.defineProperty(realWindow, BRANDED, {
      configurable: true,
      get(this: unknown) {
        if (this !== window) throw new TypeError('Illegal invocation');
        return 42;
      },
    });
    try {
      const win = makeSyntheticWin('https://acme.lightning.force.com/x');
      expect(() => (win as unknown as Record<string, unknown>)[BRANDED]).not.toThrow();
      expect((win as unknown as Record<string, unknown>)[BRANDED]).toBe(42);
    } finally {
      delete realWindow[BRANDED];
    }
  });

  it('still reports the org URL from the faked location', () => {
    // The one property that must NOT come from the real window.
    const win = makeSyntheticWin('https://acme.lightning.force.com/lightning/setup/x');
    expect(win.location.hostname).toBe('acme.lightning.force.com');
    expect(window.location.hostname).not.toBe('acme.lightning.force.com');
  });

  it('reports the org URL from location while delegating other members', () => {
    const win = makeSyntheticWin('https://acme.lightning.force.com/lightning/setup/SetupOneHome/home');
    expect(win.location.hostname).toBe('acme.lightning.force.com');
    expect(win.location.origin).toBe('https://acme.lightning.force.com');
    // A non-location member still delegates to the real window.
    expect(typeof win.setTimeout).toBe('function');
  });
});

describe('bootHost', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  function boot(): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
    });
    return root;
  }

  it('renders the host chrome with the given title and org', () => {
    const root = boot();
    // Product identity moved to the sidebar brand block; the header now carries
    // only what's about the org.
    expect(root.querySelector('#sfdt-sidebar .brandblock .title')?.textContent).toBe('SFDT Panel');
    // The mark is the SVG, not a character in the string. Callers pass plain
    // text — this used to strip a leading ⚡ that every caller sent and the
    // brand block immediately discarded.
    const brandIcon = root.querySelector('#sfdt-sidebar .brandblock .name svg[data-sfdt-icon]');
    expect(brandIcon?.getAttribute('data-sfdt-icon')).toBe('bolt');
    expect(root.querySelector('#sfdt-panes .welcome')).not.toBeNull();
  });

  it('shows the org short name with the full host on hover', () => {
    // The raw host is ~50 characters and the shared suffix carries no
    // information; rendering it in full took four lines of the panel header.
    const root = boot();
    const org = root.querySelector('#sfdt-topbar .org');
    expect(org?.textContent).toBe('acme');
    expect(org?.getAttribute('title')).toBe('acme.my.salesforce.com');
  });

  it('puts the header inside the main column, not above the sidebar', () => {
    const root = boot();
    expect(root.querySelector('#sfdt-main > #sfdt-topbar')).not.toBeNull();
  });

  it('registers every workspace tool as a sidebar entry (feature registration)', () => {
    const root = boot();
    const expected = WORKSPACE_TOOLS.filter((id) => FEATURE_ICONS[id]).length;
    expect(root.querySelectorAll('#sfdt-sidebar .tool').length).toBe(expected);
    expect(expected).toBeGreaterThan(0);
  });

  it('registers the workspace view sink so tools render into panes, not modals', () => {
    boot();
    expect(inWorkspace()).toBe(true);
  });

  it('opens a tool into a tab pane when its sidebar entry is clicked (present-view routing)', () => {
    const root = boot();
    const tools = root.querySelectorAll<HTMLElement>('#sfdt-sidebar .tool');
    (tools[0] as HTMLElement).click();
    // openTool appends a pending pane into #sfdt-panes and dispatches the tool;
    // synchronous tools present immediately into that pane (a tab chip appears),
    // async ones present on a later microtask — either way a pane now exists.
    expect(root.querySelectorAll('#sfdt-panes .pane').length).toBeGreaterThan(0);
  });
});

// Regression cover for the gap this replaced: the Workspace built its sidebar
// straight from WORKSPACE_TOOLS with no reference to settings, so a tool the
// user had switched off in Settings disappeared from the ⚡ menu on Salesforce
// pages (entrypoints/content.ts gates on isFeatureEnabled) and stayed visible
// here.
describe('bootHost — feature kill switches', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  function bootWith(isEnabled: (id: string) => boolean): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
      isEnabled,
    });
    return root;
  }

  it('omits a disabled tool from the sidebar entirely', () => {
    const root = bootWith((id) => id !== 'soql-runner');
    expect(root.querySelector('[data-tool-id="soql-runner"]')).toBeNull();
    expect(root.querySelector('[data-tool-id="apex-anonymous"]')).not.toBeNull();
  });

  it('omits a disabled tool from Quick actions too', () => {
    // Quick actions are drawn from WORKSPACE_PRIMARY, so a naive implementation
    // filters the sidebar and leaves a dead shortcut on the Overview.
    const root = bootWith((id) => id !== 'soql-runner');
    const quick = root.querySelectorAll('.welcome .quick [data-tool-id]');
    const ids = Array.from(quick).map((n) => n.getAttribute('data-tool-id'));
    expect(ids).not.toContain('soql-runner');
    expect(ids.length).toBeGreaterThan(0);
  });

  it('shows everything when no gate is supplied (unchanged default)', () => {
    const root = bootWith(() => true);
    const expected = WORKSPACE_TOOLS.filter((id) => FEATURE_ICONS[id]).length;
    expect(root.querySelectorAll('#sfdt-sidebar .tool').length).toBe(expected);
  });

  it('renders an empty sidebar rather than throwing when everything is off', () => {
    const root = bootWith(() => false);
    expect(root.querySelectorAll('#sfdt-sidebar .tool').length).toBe(0);
    expect(root.querySelector('#sfdt-panes .welcome')).not.toBeNull();
  });
});

describe('bootHost — sidebar curation', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  function boot(over: Record<string, unknown> = {}): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
      ...over,
    });
    return root;
  }

  it('shows the primary tools directly and hides the long tail behind All tools', () => {
    const root = boot();
    const allTools = root.querySelector<HTMLElement>('.all-tools');
    expect(allTools).not.toBeNull();
    expect(allTools!.hidden).toBe(true);

    // A primary tool is a direct sidebar row; a non-primary one lives inside the
    // collapsed disclosure. Getting this backwards is the whole point of the split.
    const primaryId = WORKSPACE_PRIMARY[0]!;
    const primaryBtn = root.querySelector(`[data-tool-id="${primaryId}"]`);
    expect(primaryBtn?.parentElement?.className).toBe('nav');

    const secondaryId = WORKSPACE_TOOLS.find((id) => !WORKSPACE_PRIMARY.includes(id))!;
    expect(root.querySelector(`[data-tool-id="${secondaryId}"]`)?.parentElement).toBe(allTools);
  });

  it('the All tools toggle is a real disclosure', () => {
    const root = boot();
    const toggle = root.querySelector<HTMLElement>('#sfdt-all-tools')!;
    const allTools = root.querySelector<HTMLElement>('.all-tools')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(allTools.id);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(allTools.hidden).toBe(false);

    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(allTools.hidden).toBe(true);
  });

  it('reports every tool open so the MRU learns from the Workspace', async () => {
    // Before this, pushRecent had exactly one caller (the command palette), so
    // Recent could never reflect Workspace use.
    const opened: string[] = [];
    const root = boot({ onToolOpened: (id: string) => opened.push(id) });
    root.querySelector<HTMLElement>(`[data-tool-id="${WORKSPACE_PRIMARY[0]}"]`)!.click();
    expect(opened).toEqual([WORKSPACE_PRIMARY[0]]);
  });

  it('hides the Recent group when there is no history', async () => {
    const root = boot({ loadRecents: async () => [] });
    await flush();
    const group = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group')).find(
      (g) => g.textContent === 'Recent',
    );
    expect(group?.hidden).toBe(true);
  });

  it('shows recent tools, newest first, capped', async () => {
    const recents = ['metadata-scan', 'org-limits', 'event-monitor', 'data-import', 'field-creator'];
    const root = boot({ loadRecents: async () => recents });
    await flush();
    const group = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group')).find(
      (g) => g.textContent === 'Recent',
    );
    expect(group?.hidden).toBe(false);
    const shown = Array.from(
      group!.nextElementSibling!.querySelectorAll('[data-tool-id]'),
    ).map((n) => n.getAttribute('data-tool-id'));
    expect(shown).toEqual(recents.slice(0, 4));
  });

  it('skips recent ids that are no longer available rather than rendering dead rows', async () => {
    const root = boot({
      loadRecents: async () => ['not-a-real-tool', 'org-limits'],
      isEnabled: (id: string) => id !== 'metadata-scan',
    });
    await flush();
    const group = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group')).find(
      (g) => g.textContent === 'Recent',
    );
    const shown = Array.from(
      group!.nextElementSibling!.querySelectorAll('[data-tool-id]'),
    ).map((n) => n.getAttribute('data-tool-id'));
    expect(shown).toEqual(['org-limits']);
  });

  it('omits recents that are already visible under Tools', async () => {
    // Listing SOQL Query Runner in Recent and again six rows down under Tools is
    // noise on the tab, and in the panel's icon rail it is the same glyph twice
    // with nothing to tell them apart.
    const root = boot({
      loadRecents: async () => [WORKSPACE_PRIMARY[0]!, 'org-limits'],
    });
    await flush();
    const group = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group')).find(
      (g) => g.textContent === 'Recent',
    );
    const shown = Array.from(
      group!.nextElementSibling!.querySelectorAll('[data-tool-id]'),
    ).map((n) => n.getAttribute('data-tool-id'));
    expect(shown).toEqual(['org-limits']);
  });

  it('survives a rejected recents read', async () => {
    const root = boot({
      loadRecents: async () => {
        throw new Error('storage gone');
      },
    });
    await flush();
    expect(root.querySelector('#sfdt-sidebar')).not.toBeNull();
  });
});

describe('bootHost — header tool search', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  function boot(): { root: HTMLElement; search: HTMLInputElement } {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
    });
    return { root, search: root.querySelector<HTMLInputElement>('#sfdt-topbar .search input')! };
  }

  function type(search: HTMLInputElement, value: string): void {
    search.value = value;
    search.dispatchEvent(new Event('input'));
  }

  /**
   * Tool ids actually on screen. Walks ancestors as well as the button itself:
   * the long-tail rows are un-hidden individually but sit inside a hidden
   * `.all-tools` container, so checking only the button reports them as visible.
   */
  function visibleToolIds(root: HTMLElement): string[] {
    return Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar [data-tool-id]'))
      .filter((n) => {
        for (let el: HTMLElement | null = n; el && el !== root; el = el.parentElement) {
          if (el.hidden) return false;
        }
        return true;
      })
      .map((n) => n.getAttribute('data-tool-id')!);
  }

  it('narrows the sidebar to matching tools', () => {
    const { root, search } = boot();
    type(search, 'schema');
    const shown = visibleToolIds(root);
    expect(shown).toContain('schema-browser');
    expect(shown).not.toContain('apex-anonymous');
  });

  it('searches the long tail too, not just the seven on show', () => {
    // The trap: non-primary tools live inside a collapsed disclosure. A filter
    // that only walked the visible rows would silently omit 18 of 25 tools —
    // worse than having no search at all.
    const { root, search } = boot();
    const buried = WORKSPACE_TOOLS.find((id) => !WORKSPACE_PRIMARY.includes(id))!;
    type(search, FEATURE_ICONS[buried]!.label.toLowerCase());
    expect(visibleToolIds(root)).toContain(buried);
  });

  it('hides the group headings and the disclosure while filtering', () => {
    const { root, search } = boot();
    type(search, 'schema');
    const toggle = root.querySelector<HTMLElement>('#sfdt-all-tools')!;
    expect(toggle.hidden).toBe(true);
    const headings = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group'));
    expect(headings.every((h) => h.hidden)).toBe(true);
  });

  it('restores the collapsed state exactly when the search is cleared', () => {
    const { root, search } = boot();
    const toggle = root.querySelector<HTMLElement>('#sfdt-all-tools')!;
    const allTools = root.querySelector<HTMLElement>('.all-tools')!;

    type(search, 'schema');
    type(search, '');

    expect(toggle.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(allTools.hidden).toBe(true);
    expect(visibleToolIds(root)).toEqual(WORKSPACE_PRIMARY.slice());
  });

  it('leaves an expanded disclosure expanded after a search is cleared', () => {
    const { root, search } = boot();
    const toggle = root.querySelector<HTMLElement>('#sfdt-all-tools')!;
    const allTools = root.querySelector<HTMLElement>('.all-tools')!;
    toggle.click();

    type(search, 'schema');
    type(search, '');

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(allTools.hidden).toBe(false);
  });

  it('says so when nothing matches', () => {
    const { root, search } = boot();
    const noMatches = root.querySelector<HTMLElement>('#sfdt-sidebar .no-matches')!;
    expect(noMatches.hidden).toBe(true);
    type(search, 'zzzzzznope');
    expect(noMatches.hidden).toBe(false);
    expect(visibleToolIds(root)).toEqual([]);
    type(search, '');
    expect(noMatches.hidden).toBe(true);
  });

  it('does not resurrect an empty Recent group when the search clears', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
      loadRecents: async () => [],
    });
    await flush();
    const search = root.querySelector<HTMLInputElement>('#sfdt-topbar .search input')!;
    type(search, 'schema');
    type(search, '');
    const recentGroup = Array.from(root.querySelectorAll<HTMLElement>('#sfdt-sidebar .group')).find(
      (g) => g.textContent === 'Recent',
    )!;
    expect(recentGroup.hidden).toBe(true);
  });
});

// The docked panel is ~400px. Rendering the tab layout there produced a 160px
// sidebar where every label truncated to "SOQL Query…", a brand block over four
// lines, and a raw hostname header over four more — so the panel is a distinct
// surface, not a breakpoint.
describe('bootHost — panel surface', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  function boot(variant?: 'tab' | 'panel'): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'wise-goat-4iv2wx-dev-ed.trailblaze.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
      ...(variant ? { variant } : {}),
    });
    return root;
  }

  it('marks the surface so the stylesheet can restructure it', () => {
    expect(boot('panel').getAttribute('data-sfdt-surface')).toBe('panel');
  });

  it('defaults to the tab surface when no variant is given', () => {
    expect(boot().getAttribute('data-sfdt-surface')).toBe('tab');
  });

  it('keeps every tool name reachable when the rail hides labels', () => {
    // The rail shows icons only, so the name has to survive for pointer hover
    // AND assistive tech — an unlabelled icon button is unusable for both.
    const root = boot('panel');
    const tools = root.querySelectorAll<HTMLElement>('#sfdt-sidebar [data-tool-id]');
    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      const id = tool.getAttribute('data-tool-id')!;
      const label = FEATURE_ICONS[id]!.label;
      expect(tool.getAttribute('title')).toBe(label);
      expect(tool.getAttribute('aria-label')).toBe(label);
    }
  });

  it('labels the All tools disclosure for the rail too', () => {
    const toggle = boot('panel').querySelector<HTMLElement>('#sfdt-all-tools')!;
    expect(toggle.getAttribute('aria-label')).toMatch(/^All tools \(\d+\)$/);
    expect(toggle.getAttribute('title')).toBe(toggle.getAttribute('aria-label'));
  });

  it('shortens a long org host in both the header and the Overview', () => {
    const root = boot('panel');
    const header = root.querySelector('#sfdt-topbar .org');
    expect(header?.textContent).toBe('wise-goat-4iv2wx-dev-ed.trailblaze');
    expect(header?.getAttribute('title')).toBe(
      'wise-goat-4iv2wx-dev-ed.trailblaze.my.salesforce.com',
    );
    const heading = root.querySelector('#sfdt-panes .welcome .greeting h2');
    expect(heading?.textContent).toBe('wise-goat-4iv2wx-dev-ed.trailblaze');
    expect(heading?.getAttribute('title')).toBe(
      'wise-goat-4iv2wx-dev-ed.trailblaze.my.salesforce.com',
    );
  });

  it('builds the same DOM for both surfaces — the difference is CSS', () => {
    // If the two surfaces diverged structurally they would need two DOM
    // builders and would drift; the variant may only change the attribute.
    const panelTools = boot('panel').querySelectorAll('#sfdt-sidebar [data-tool-id]').length;
    const tabTools = boot('tab').querySelectorAll('#sfdt-sidebar [data-tool-id]').length;
    expect(panelTools).toBe(tabTools);
  });
});

describe('bootHost — Overview activity panel', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
    setWorkspaceViewSink(null);
  });

  const ENTRY: ActivityEntry = {
    ts: Date.UTC(2026, 6, 30, 14, 24, 2),
    featureId: 'soql-runner',
    action: 'SOQL Query',
    resource: 'SELECT Id FROM Account',
    status: 'success',
  };

  function boot(over: Record<string, unknown> = {}): HTMLElement {
    const root = document.createElement('div');
    document.body.appendChild(root);
    bootHost(root, 'acme.my.salesforce.com', {
      title: 'SFDT Panel',
      onSwitchOrg: () => {},
      ...over,
    });
    return root;
  }

  it('is absent entirely when no loader is wired (never a stuck "Loading…")', () => {
    const root = boot();
    expect(root.querySelector('.welcome .sfdt-table')).toBeNull();
  });

  it('renders a row per entry', async () => {
    const root = boot({ loadActivity: async () => [ENTRY, { ...ENTRY, status: 'failed' as const }] });
    await flush();
    const rows = root.querySelectorAll('.welcome .sfdt-table tbody tr');
    expect(rows.length).toBe(2);
    expect(rows[0]?.textContent).toContain('SOQL Query');
    expect(rows[0]?.textContent).toContain('SELECT Id FROM Account');
    expect(rows[0]?.textContent).toContain('Success');
    expect(rows[1]?.textContent).toContain('Failed');
  });

  it('explains itself when the log is empty instead of showing a bare table', async () => {
    const root = boot({ loadActivity: async () => [] });
    await flush();
    expect(root.querySelectorAll('.welcome .sfdt-table tbody tr').length).toBe(0);
    // Match on the activity copy specifically: the health tiles render their own
    // `.empty` node, so a bare `.empty` selector would pass on the wrong element.
    const empty = Array.from(root.querySelectorAll<HTMLElement>('.welcome .empty')).find((n) =>
      n.textContent?.startsWith('Nothing yet.'),
    );
    expect(empty).toBeDefined();
    expect(empty!.hidden).toBe(false);
  });

  it('clears the log and re-reads', async () => {
    let entries: ActivityEntry[] = [ENTRY];
    let cleared = 0;
    const root = boot({
      loadActivity: async () => entries,
      clearActivity: async () => {
        cleared++;
        entries = [];
      },
    });
    await flush();
    expect(root.querySelectorAll('.welcome .sfdt-table tbody tr').length).toBe(1);

    const clearBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('.welcome button')).find(
      (b) => b.textContent === 'Clear',
    )!;
    clearBtn.click();
    await flush();
    expect(cleared).toBe(1);
    expect(root.querySelectorAll('.welcome .sfdt-table tbody tr').length).toBe(0);
  });

  it('disables Clear when no clear handler is wired', async () => {
    const root = boot({ loadActivity: async () => [ENTRY] });
    await flush();
    const clearBtn = Array.from(root.querySelectorAll<HTMLButtonElement>('.welcome button')).find(
      (b) => b.textContent === 'Clear',
    )!;
    expect(clearBtn.disabled).toBe(true);
  });

  it('survives a rejected activity read', async () => {
    const root = boot({
      loadActivity: async () => {
        throw new Error('storage gone');
      },
    });
    await flush();
    expect(root.querySelector('.welcome')).not.toBeNull();
  });
});

// The API version decides which endpoints every tool here calls. It used to
// live only in the badge's `title`, so the one number a developer most often
// wants to confirm was invisible until they hovered.
describe('formatReleaseBadge', () => {
  it('shows the release and the API version together', () => {
    expect(formatReleaseBadge({ release: "Summer '26", apiVersion: 65, preview: false })).toBe(
      "Summer '26 · v65.0",
    );
  });

  it('always writes one decimal place, as Salesforce does', () => {
    // parseFloat('65.0') is 65 — printed bare it would read "v65", which is not
    // how any Salesforce endpoint or doc spells it.
    expect(formatReleaseBadge({ release: "Winter '27", apiVersion: 66, preview: false })).toContain(
      'v66.0',
    );
    expect(formatReleaseBadge({ release: 'x', apiVersion: 65.5, preview: false })).toContain('v65.5');
  });

  it('states preview in TEXT, not by the amber tint alone', () => {
    // Colour must never be the only carrier of status (CONVENTIONS.md a11y).
    const out = formatReleaseBadge({ release: "Spring '27", apiVersion: 67, preview: true });
    expect(out).toBe("Spring '27 · v67.0 · preview");
    expect(out.toLowerCase()).toContain('preview');
  });

  it('omits the preview marker on a GA org', () => {
    expect(
      formatReleaseBadge({ release: "Summer '26", apiVersion: 65, preview: false }),
    ).not.toContain('preview');
  });
});
