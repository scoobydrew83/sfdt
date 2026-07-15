// Keyboard-command routing for the manifest `commands` block. The background
// service worker registers chrome.commands.onCommand at top level, so these
// shortcuts fire independent of whether the content script on the active tab
// has settled yet (that's the whole reason declared commands beat per-feature
// in-page keydown listeners).
//
// planCommand() is pure — it turns a command id + the active tab into an
// intent the background executes. Keeping the decision here (not inline in the
// service worker) is what makes command→action routing unit-testable.

import { salesforceHostFromUrl } from './sf-tab.js';

/** The three declared commands. Mirrors the `commands` block in wxt.config.ts. */
export const COMMAND_IDS = ['open-workspace', 'open-palette', 'toggle-inspector'] as const;
export type CommandId = (typeof COMMAND_IDS)[number];

/** Minimal shape of the active tab the router needs. */
export interface CommandTab {
  id?: number;
  url?: string;
}

export type CommandPlan =
  // Open the standalone Workspace tab, seeded with the active tab's org (empty
  // string = let the Workspace show its org picker).
  | { kind: 'open-workspace'; org: string }
  // Forward a message to the active tab's content script (opening the ⚡ menu,
  // or surfacing the inspector). A no-op if the tab has no content script.
  | { kind: 'message-tab'; tabId: number; message: { action: string } }
  // Nothing actionable (unknown command, or a tab without an id).
  | { kind: 'noop' };

/**
 * Decide what a command should do given the active tab. Pure and total —
 * every command id maps to a plan, and anything unroutable degrades to noop.
 */
export function planCommand(command: string, tab: CommandTab | undefined): CommandPlan {
  switch (command) {
    case 'open-workspace': {
      // Seed with the active tab's org when it's a Salesforce page; otherwise
      // the Workspace opens its own org picker.
      const org = salesforceHostFromUrl(tab?.url) ?? '';
      return { kind: 'open-workspace', org };
    }
    case 'open-palette': {
      // Until P2-2 ships the command palette, this opens the ⚡ side menu on the
      // active tab. Requires a content script, so it only makes sense on a tab
      // that has an id; a non-Salesforce tab simply has no listener (no-op).
      if (typeof tab?.id !== 'number') return { kind: 'noop' };
      return { kind: 'message-tab', tabId: tab.id, message: { action: 'openPalette' } };
    }
    case 'toggle-inspector': {
      // No inspector exists yet (the LWC inspector lands in P6-1). The content
      // script answers this with a "not available yet" toast for now.
      if (typeof tab?.id !== 'number') return { kind: 'noop' };
      return { kind: 'message-tab', tabId: tab.id, message: { action: 'toggleInspector' } };
    }
    default:
      return { kind: 'noop' };
  }
}
