import type { SavedQuery } from './soql-runner.js';

/**
 * A built-in, read-only SOQL template. Shares `q`/`api` with {@link SavedQuery}
 * so the Saved SOQL panel can render and load it through the same code path,
 * plus a short `description` shown under the name.
 */
export interface SoqlTemplate {
  name: string;
  description: string;
  q: string;
  api: SavedQuery['api'];
}

/**
 * Built-in admin/dev query pack. Every entry is plain SOQL that runs on a
 * vanilla Developer Edition org against standard objects (REST or Tooling API).
 * These are surfaced read-only ("Templates" group) — clicking copies the query
 * into the SOQL Runner. Do not add org-specific object/field names here.
 */
export const SOQL_TEMPLATES: readonly SoqlTemplate[] = [
  {
    name: 'Apex test coverage',
    description: 'Per-class covered vs uncovered line counts (Tooling API).',
    q: 'SELECT ApexClassOrTrigger.Name, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate ORDER BY ApexClassOrTrigger.Name',
    api: 'tooling',
  },
  {
    name: 'Validation rules',
    description: 'All validation rules with their object and active state (Tooling API).',
    q: 'SELECT ValidationName, EntityDefinition.QualifiedApiName, Active FROM ValidationRule ORDER BY EntityDefinition.QualifiedApiName',
    api: 'tooling',
  },
  {
    name: 'Login history',
    description: 'Recent logins with source IP, type and status.',
    q: 'SELECT UserId, LoginTime, LoginType, SourceIp, Status, Browser FROM LoginHistory ORDER BY LoginTime DESC LIMIT 100',
    api: 'rest',
  },
  {
    name: 'Setup audit trail',
    description: 'Recent setup/config changes and who made them.',
    q: 'SELECT Action, Section, CreatedBy.Username, CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate DESC LIMIT 100',
    api: 'rest',
  },
  {
    name: 'API / usage limit snapshot',
    description: 'Usage-based entitlements: amount used vs currently allowed.',
    q: 'SELECT MasterLabel, Setting, AmountUsed, CurrentAmountAllowed, Frequency FROM TenantUsageEntitlement ORDER BY MasterLabel',
    api: 'rest',
  },
  {
    name: 'Recent deploy requests',
    description: 'Latest metadata deployments with status and timing (Tooling API).',
    q: 'SELECT Id, Status, StartDate, CompletedDate, CreatedBy.Name FROM DeployRequest ORDER BY CompletedDate DESC NULLS LAST LIMIT 50',
    api: 'tooling',
  },
  {
    name: 'Active TraceFlags',
    description: 'Debug-log trace flags and when they expire (Tooling API).',
    q: 'SELECT Id, LogType, TracedEntityId, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag ORDER BY ExpirationDate DESC',
    api: 'tooling',
  },
  {
    name: 'Record type list',
    description: 'All record types across objects with active state.',
    q: 'SELECT Id, Name, DeveloperName, SobjectType, IsActive FROM RecordType ORDER BY SobjectType, DeveloperName',
    api: 'rest',
  },
];

/**
 * Minimal structural validator for the template pack. The extension has no full
 * SOQL parser, so this asserts the shape every SELECT template must have:
 * a `SELECT <fields> FROM <object>` head and balanced single quotes.
 *
 * ponytail: structural check, not a grammar. Enough to catch a typo'd template
 * (missing FROM, dangling quote); swap for a real parser only if templates ever
 * grow subqueries/relationship syntax this can't vouch for.
 */
export function isValidTemplateSoql(query: string): boolean {
  if (typeof query !== 'string') return false;
  const q = query.trim();
  if (q.endsWith(';')) return false;
  if ((q.match(/'/g)?.length ?? 0) % 2 !== 0) return false;
  return /^SELECT\s+.+\s+FROM\s+[A-Za-z][\w.]*/is.test(q);
}
