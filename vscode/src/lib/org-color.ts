/**
 * Pure org-classification + window-tint mapping. Tinting the VS Code window by
 * org type (prod=red, sandbox=orange, scratch/dev=green) prevents wrong-org
 * mistakes. The extension applies the returned customizations via
 * `workbench.colorCustomizations`; this module holds the pure mapping.
 */

export type OrgType = 'production' | 'sandbox' | 'scratch' | 'developer' | 'other';

export interface OrgFacts {
  instanceUrl?: string;
  isSandbox?: boolean;
  isScratch?: boolean;
  /** Trial / Developer Edition org. */
  isDevEdition?: boolean;
}

/** Classify an org from the facts `sf org display --json` exposes. */
export function classifyOrg(facts: OrgFacts): OrgType {
  if (facts.isScratch) return 'scratch';
  if (facts.isSandbox) return 'sandbox';
  if (facts.isDevEdition) return 'developer';
  const url = facts.instanceUrl ?? '';
  if (/\.sandbox\.|\.cs\d+\.|--/.test(url)) return 'sandbox';
  if (/\.develop\.|scratch/.test(url)) return 'scratch';
  if (url) return 'production';
  return 'other';
}

const TINT: Record<OrgType, string | null> = {
  production: '#8b1a1a', // red — be careful
  sandbox: '#a8580f', // orange
  scratch: '#1f7a3d', // green
  developer: '#1f7a3d', // green
  other: null,
};

/**
 * Color customizations to merge into `workbench.colorCustomizations`, or null
 * when the org type should not be tinted (`other`).
 */
export function colorForOrg(type: OrgType): Record<string, string> | null {
  const base = TINT[type];
  if (!base) return null;
  return {
    'activityBar.background': base,
    'titleBar.activeBackground': base,
    'statusBar.background': base,
    'titleBar.activeForeground': '#ffffff',
    'statusBar.foreground': '#ffffff',
  };
}
