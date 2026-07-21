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
} from '../ui/workspace-host.js';
import { inWorkspace, setWorkspaceViewSink } from '../ui/present-view.js';
import { FEATURE_ICONS, WORKSPACE_TOOLS } from '../lib/feature-icons.js';

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
      title: '⚡ SFDT Panel',
      onSwitchOrg: () => {},
    });
    return root;
  }

  it('renders the host chrome with the given title and org', () => {
    const root = boot();
    expect(root.querySelector('#sfdt-topbar .title')?.textContent).toBe('⚡ SFDT Panel');
    expect(root.querySelector('#sfdt-topbar .org')?.textContent).toBe('acme.my.salesforce.com');
    expect(root.querySelector('#sfdt-panes .welcome')).not.toBeNull();
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
