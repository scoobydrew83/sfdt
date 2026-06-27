/**
 * Pure prerequisite evaluation for the welcome/onboarding flow. The extension
 * probes the environment (sf/sfdt on PATH, .sfdt/config.json present) and passes
 * the booleans here; this module decides what (if anything) is missing and what
 * the welcome view should offer. Free of any `vscode` import.
 */

export interface PrereqProbe {
  hasSf: boolean;
  hasSfdt: boolean;
  hasConfig: boolean;
}

export interface PrereqAction {
  id: string;
  label: string;
}

export interface PrereqState {
  /** True when everything needed to use the extension is present. */
  ready: boolean;
  /** Missing prerequisites, in the order they should be resolved. */
  missing: PrereqAction[];
}

export function evaluatePrereqs(probe: PrereqProbe): PrereqState {
  const missing: PrereqAction[] = [];
  if (!probe.hasSf) missing.push({ id: 'install-sf', label: 'Install the Salesforce CLI (sf)' });
  if (!probe.hasSfdt) missing.push({ id: 'install-sfdt', label: 'Install the sfdt CLI' });
  // Config only matters once the CLI exists.
  if (probe.hasSfdt && !probe.hasConfig) missing.push({ id: 'init', label: 'Run sfdt init' });
  return { ready: missing.length === 0, missing };
}
