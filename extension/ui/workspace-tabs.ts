// Tabbed tool host for the Workspace. Each opened tool becomes a persistent
// tab: its pane keeps its DOM (and therefore its state) when you switch away,
// and only the tab's × tears it down — so a stray click never discards work.
//
// Features don't know about tabs: they call presentView(), which (because the
// Workspace registers a sink here) routes into the active tool's pane instead of
// a dismissible modal. Extracted from the app entrypoint so the tab lifecycle is
// unit-testable without booting the whole Workspace.

import {
  setWorkspaceViewSink,
  presentAsModal,
  type PresentOpts,
  type ViewHandle,
} from './present-view.js';

export interface WorkspaceTabsOptions {
  /** Container for the tab chips. */
  tabbar: HTMLElement;
  /** Container the tool panes mount into. */
  panes: HTMLElement;
  /** Shown when no tab is active; hidden while a tool is open. */
  welcome: HTMLElement;
  /** Activate a tool (the registry's `dispatch(id, 'activate')`). */
  dispatch: (id: string) => void;
  /** Display label for a tool's tab chip. */
  labelFor: (id: string) => string;
  /** Document to build in (defaults to the global document). */
  doc?: Document;
}

export interface WorkspaceTabs {
  /** Open a tool — focus its tab if already open, else create and focus it. */
  openTool(id: string): void;
  /** Is a tab open for this tool? */
  has(id: string): boolean;
  /** The currently active tool id, or null (welcome). */
  activeId(): string | null;
  /** Number of open tabs. */
  count(): number;
}

interface Tab {
  pane: HTMLElement;
  chip: HTMLElement;
  onClose?: () => void;
}

export function createWorkspaceTabs(opts: WorkspaceTabsOptions): WorkspaceTabs {
  const doc = opts.doc ?? document;
  const tabs = new Map<string, Tab>();
  let active: string | null = null;
  let pendingPane: HTMLElement | null = null;
  let pendingToolId: string | null = null;

  function activate(id: string | null): void {
    active = id;
    opts.welcome.style.display = id === null ? '' : 'none';
    for (const [tid, t] of tabs) {
      t.pane.style.display = tid === id ? 'flex' : 'none';
      t.chip.classList.toggle('active', tid === id);
    }
  }

  function closeTab(id: string): void {
    const t = tabs.get(id);
    if (!t) return;
    tabs.delete(id);
    t.pane.remove();
    t.chip.remove();
    t.onClose?.();
    if (active === id) activate([...tabs.keys()].pop() ?? null);
  }

  function makeChip(label: string, id: string): HTMLElement {
    const chip = doc.createElement('div');
    chip.className = 'tab';
    const text = doc.createElement('span');
    text.textContent = label;
    const x = doc.createElement('button');
    x.className = 'x';
    x.setAttribute('aria-label', 'Close tab');
    x.textContent = '×';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(id);
    });
    chip.append(text, x);
    chip.addEventListener('click', () => activate(id));
    return chip;
  }

  // Workspace sink: mount the feature's body/footer into the pending tool's pane.
  // Single-instance by design — `setWorkspaceViewSink` writes a module-level
  // singleton in present-view.ts. There is exactly one Workspace per page load
  // (an org switch navigates via window.location, reloading the page), so this is
  // never called twice in one lifetime. If that ever changes, the sink would need
  // clearing on teardown to avoid stale-tab fallback-to-modal.
  setWorkspaceViewSink((view: PresentOpts): ViewHandle => {
    const pane = pendingPane;
    const toolId = pendingToolId;
    if (!pane || !toolId) {
      // A feature presented outside a tool click — fall back to a modal.
      return presentAsModal(view);
    }
    if (!view.body.style.flex) view.body.style.flex = '1';
    pane.appendChild(view.body);
    if (view.footer) pane.appendChild(view.footer);
    const chip = makeChip(opts.labelFor(toolId), toolId);
    opts.tabbar.appendChild(chip);
    tabs.set(toolId, { pane, chip, onClose: view.onClose });
    activate(toolId);
    return { close: () => closeTab(toolId), root: pane };
  });

  function openTool(id: string): void {
    if (tabs.has(id)) {
      activate(id);
      return;
    }
    // Drop a stale empty pane from a previous open that never presented.
    if (pendingPane && !pendingPane.firstChild) pendingPane.remove();
    const pane = doc.createElement('div');
    pane.className = 'pane';
    pane.style.display = 'none';
    opts.panes.appendChild(pane);
    pendingPane = pane;
    pendingToolId = id;
    opts.dispatch(id); // feature calls presentView() synchronously → sink mounts here
    pendingPane = null;
    pendingToolId = null;
  }

  return {
    openTool,
    has: (id) => tabs.has(id),
    activeId: () => active,
    count: () => tabs.size,
  };
}
