import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createWorkspaceTabs } from '../ui/workspace-tabs.js';
import { presentView, setWorkspaceViewSink } from '../ui/present-view.js';

// A fake "feature" that, when dispatched, synchronously presents a body holding
// an input — so we can prove its state survives tab switches.
function makeHost() {
  const tabbar = document.createElement('div');
  const panes = document.createElement('div');
  const welcome = document.createElement('div');
  document.body.append(tabbar, panes, welcome);

  const dispatch = vi.fn((id: string) => {
    const body = document.createElement('div');
    const input = document.createElement('input');
    input.className = `input-${id}`;
    body.appendChild(input);
    presentView({ title: id, body, doc: document });
  });

  const tabs = createWorkspaceTabs({
    tabbar,
    panes,
    welcome,
    dispatch,
    labelFor: (id) => id.toUpperCase(),
  });
  return { tabs, tabbar, panes, welcome, dispatch };
}

describe('createWorkspaceTabs', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setWorkspaceViewSink(null);
  });

  it('opens a tool as a tab, hides the welcome, and never creates a modal', () => {
    const { tabs, tabbar, welcome } = makeHost();
    tabs.openTool('soql');
    expect(tabs.count()).toBe(1);
    expect(tabs.activeId()).toBe('soql');
    expect(tabbar.querySelectorAll('.tab').length).toBe(1);
    expect(welcome.style.display).toBe('none');
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull(); // not a modal
  });

  it('carries the subtitle and header actions into the pane', () => {
    // The tab chip supplies the tool's title, but nothing supplies "which
    // record am I looking at" or the view's own Fields/JSON toggle. Without a
    // pane head those are silently dropped in the Workspace and the tool looks
    // like a different product depending on where it was opened.
    const tabbar = document.createElement('div');
    const panes = document.createElement('div');
    const welcome = document.createElement('div');
    document.body.append(tabbar, panes, welcome);

    const actions = document.createElement('div');
    actions.id = 'acts';
    const dispatch = vi.fn(() => {
      presentView({
        title: 'Inspect Record',
        subtitle: 'Account · 001800000000001AAA',
        headerActions: actions,
        body: document.createElement('div'),
        doc: document,
      });
    });
    const tabs = createWorkspaceTabs({
      tabbar, panes, welcome, dispatch, labelFor: (id) => id.toUpperCase(),
    });

    tabs.openTool('inspect-record');

    const head = panes.querySelector('.sfdt-panel-head') as HTMLElement;
    expect(head).not.toBeNull();
    expect(head.querySelector('.sfdt-panel-sub')?.textContent).toBe('Account · 001800000000001AAA');
    expect(head.querySelector('#acts')).not.toBeNull();
    // The chip already says "INSPECT-RECORD" and owns the ×; repeating either
    // in the pane would be two titles and two close affordances.
    expect(head.querySelector('.sfdt-panel-title')).toBeNull();
    expect(head.querySelector('button[aria-label="Close"]')).toBeNull();
  });

  it('adds no pane head for a view that supplies neither', () => {
    const { tabs, panes } = makeHost();
    tabs.openTool('soql');
    expect(panes.querySelector('.sfdt-panel-head')).toBeNull();
  });

  it('mounts a tab (not a modal) when the tool presents on a later microtask', async () => {
    // Real tools like SOQL Runner `await loadSettings()` before calling
    // presentView, so the view arrives after openTool has returned. The sink must
    // still route it into the tab pane, not fall back to a modal.
    const tabbar = document.createElement('div');
    const panes = document.createElement('div');
    const welcome = document.createElement('div');
    document.body.append(tabbar, panes, welcome);

    const dispatch = vi.fn(async (id: string) => {
      await Promise.resolve(); // yield the microtask, exactly like an awaited load
      const body = document.createElement('div');
      presentView({ title: id, body, doc: document });
    });

    const tabs = createWorkspaceTabs({
      tabbar,
      panes,
      welcome,
      dispatch,
      labelFor: (id) => id.toUpperCase(),
    });

    tabs.openTool('soql');
    await Promise.resolve(); // let the async dispatch present
    await Promise.resolve();

    expect(tabs.count()).toBe(1);
    expect(tabs.activeId()).toBe('soql');
    expect(tabbar.querySelectorAll('.tab').length).toBe(1);
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull(); // not a modal
  });

  it('re-opening an already-open tool just focuses it (no re-dispatch, no dup tab)', () => {
    const { tabs, dispatch } = makeHost();
    tabs.openTool('soql');
    tabs.openTool('apex');
    tabs.openTool('soql'); // already open → activate, not recreate
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(tabs.count()).toBe(2);
    expect(tabs.activeId()).toBe('soql');
  });

  it('keeps each tab’s DOM state alive when switching away and back', () => {
    const { tabs } = makeHost();
    tabs.openTool('soql');
    const soqlInput = document.querySelector('.input-soql') as HTMLInputElement;
    soqlInput.value = 'SELECT Id FROM Account'; // user types

    tabs.openTool('apex'); // switch away — soql pane is hidden, not destroyed
    expect((document.querySelector('.input-soql') as HTMLInputElement)).not.toBeNull();
    expect(tabs.activeId()).toBe('apex');

    tabs.openTool('soql'); // back
    expect((document.querySelector('.input-soql') as HTMLInputElement).value).toBe(
      'SELECT Id FROM Account',
    ); // work preserved
  });

  it('only the active tab pane is displayed', () => {
    const { tabs, panes } = makeHost();
    tabs.openTool('soql');
    tabs.openTool('apex');
    const paneEls = [...panes.querySelectorAll('.pane')] as HTMLElement[];
    const shown = paneEls.filter((p) => p.style.display !== 'none');
    expect(shown.length).toBe(1);
  });

  it('closing a tab removes it and falls back to another open tab', () => {
    const { tabs, tabbar, welcome } = makeHost();
    tabs.openTool('soql');
    tabs.openTool('apex');
    const closeBtn = tabbar.querySelector('.tab .x') as HTMLButtonElement; // soql's ×
    closeBtn.click();
    expect(tabs.count()).toBe(1);
    expect(tabs.has('soql')).toBe(false);
    expect(tabs.activeId()).toBe('apex');
    expect(welcome.style.display).toBe('none');
  });

  it('closing the last tab returns to the welcome screen', () => {
    const { tabs, tabbar, welcome } = makeHost();
    tabs.openTool('soql');
    (tabbar.querySelector('.tab .x') as HTMLButtonElement).click();
    expect(tabs.count()).toBe(0);
    expect(tabs.activeId()).toBeNull();
    expect(welcome.style.display).toBe('');
  });
});
