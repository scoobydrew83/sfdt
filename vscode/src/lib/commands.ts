/**
 * Catalog of sfdt commands surfaced through the "SFDT: Run Command…" quick
 * pick. Pure data so it can be asserted in tests and reused by the palette.
 */

export interface CommandEntry {
  id: string;
  label: string;
  detail: string;
  /** argv passed to the sfdt CLI. */
  args: string[];
  /** When true, the command mutates the org and should confirm first. */
  destructive?: boolean;
}

export const COMMAND_CATALOG: CommandEntry[] = [
  { id: 'preflight', label: 'Preflight', detail: 'Run pre-deployment validation checks', args: ['preflight'] },
  { id: 'audit', label: 'Org Audit', detail: 'Diagnose org health (read-only)', args: ['audit', 'all'] },
  { id: 'monitor', label: 'Org Monitor', detail: 'Limits, Apex failures, security score', args: ['monitor', 'all'] },
  { id: 'backup', label: 'Backup Metadata', detail: 'Retrieve a full metadata backup', args: ['monitor', 'backup'] },
  { id: 'drift', label: 'Detect Drift', detail: 'Compare local source against the org', args: ['drift'] },
  { id: 'scan', label: 'Scan Inventory', detail: 'Fetch the org metadata inventory', args: ['scan'] },
  { id: 'quality', label: 'Quality Analysis', detail: 'Analyze Apex test quality', args: ['quality'] },
  { id: 'docs', label: 'Generate Docs', detail: 'Generate project documentation', args: ['docs', 'generate'] },
  { id: 'deploy', label: 'Deploy', detail: 'Deploy metadata to the org', args: ['deploy'], destructive: true },
];

export function findCommand(id: string): CommandEntry | undefined {
  return COMMAND_CATALOG.find((c) => c.id === id);
}
