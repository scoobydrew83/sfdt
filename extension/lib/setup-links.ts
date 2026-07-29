// The Setup deep-link map, extracted from features/setup-tabs.ts so both the
// injected Setup tab strip (setup-tabs) and the command palette (palette-sources)
// build from one source of truth. Pure data + URL builders — no DOM, no chrome.*.

import {
  lightningHostname as toLightningHost,
  setupHostname as toSetupHost,
} from './hostname.js';

export interface TabDefinition {
  id: string;
  label: string;
  buildUrl: (hostname: string) => string;
  openInNewTab: boolean;
}

export const BASE_TABS: readonly TabDefinition[] = [
  {
    id: 'sfdt_tab_flows',
    label: 'Flows',
    buildUrl: (hostname) => `https://${toSetupHost(hostname)}/lightning/setup/Flows/home`,
    openInNewTab: false,
  },
  {
    id: 'sfdt_tab_flow_trigger_explorer',
    label: 'Flow Trigger Explorer',
    buildUrl: (hostname) =>
      `https://${toLightningHost(hostname)}/interaction_explorer/flowExplorer.app`,
    openInNewTab: true,
  },
  {
    id: 'sfdt_tab_process_automation_settings',
    label: 'Process Automation Settings',
    buildUrl: (hostname) =>
      `https://${toSetupHost(hostname)}/lightning/setup/WorkflowSettings/home`,
    openInNewTab: false,
  }
];

export const AUTOMATION_HOME_TAB: TabDefinition = {
  id: 'sfdt_tab_automation_home',
  label: 'Automation Home',
  buildUrl: (hostname) => `https://${toLightningHost(hostname)}/lightning/app/standard__FlowsApp`,
  openInNewTab: true,
};
