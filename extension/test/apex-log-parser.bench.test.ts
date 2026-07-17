import { describe, it, expect } from 'vitest';
import { parseApexLog } from '../lib/apex-log/index.js';

// P3-2 PR-3: the "5 MB log doesn't block the UI thread" evidence (board AC-3).
//
// We generate a realistic ~5 MB log at RUNTIME (never commit a 5 MB fixture) by
// repeating a balanced execution block — methods, SOQL/DML/callouts, a limit
// snapshot, and USER_DEBUG noise — with globally-monotonic nanos so the tree,
// durations, and inventories all get exercised. The test asserts the pure sync
// parse finishes well within a generous CI budget, and that collectEvents:false
// is a real memory lever. The measured time is logged so the big-log strategy in
// lib/apex-log/README.md is decided by measurement, not assumption.

const TARGET_BYTES = 5 * 1024 * 1024; // ~5 MB
// Generous enough to be safe on slow CI, tight enough to catch a pathological
// (e.g. accidental O(n²)) regression. On dev hardware the parse runs ~10-15× under.
const BUDGET_MS = 2000;

/** One balanced execution block; `base` offsets nanos so they stay monotonic. */
function block(base: number): string {
  return [
    `10:00:00.000 (${base + 1000})|EXECUTION_STARTED`,
    `10:00:00.000 (${base + 2000})|CODE_UNIT_STARTED|[EXTERNAL]|apex://DataController/ACTION$load`,
    `10:00:00.000 (${base + 3000})|METHOD_ENTRY|[5]|01p5j000000DaSvAAK|DataService.loadAccounts()`,
    `10:00:00.000 (${base + 4000})|SOQL_EXECUTE_BEGIN|[7]|Aggregations:0|SELECT Id, Name FROM Account WHERE Industry = 'Tech'`,
    `10:00:00.000 (${base + 5000})|USER_DEBUG|[8]|DEBUG|loaded accounts for processing batch`,
    `10:00:00.000 (${base + 6000})|SOQL_EXECUTE_END|[7]|Rows:12`,
    `10:00:00.000 (${base + 7000})|DML_BEGIN|[9]|Op:Insert|Type:Account|Rows:3`,
    `10:00:00.000 (${base + 8000})|DML_END|[9]`,
    `10:00:00.000 (${base + 9000})|METHOD_ENTRY|[12]|01p5j000000InSvAAK|IntegrationService.push()`,
    `10:00:00.000 (${base + 10000})|CALLOUT_REQUEST|[14]|System.HttpRequest[Endpoint=https://api.example.com/v1/accounts, Method=POST]`,
    `10:00:00.000 (${base + 11000})|CALLOUT_RESPONSE|[14]|System.HttpResponse[Status=OK, StatusCode=200]`,
    `10:00:00.000 (${base + 12000})|METHOD_EXIT|[12]|01p5j000000InSvAAK|IntegrationService.push()`,
    `10:00:00.000 (${base + 13000})|METHOD_EXIT|[5]|01p5j000000DaSvAAK|DataService.loadAccounts()`,
    `10:00:00.000 (${base + 14000})|CUMULATIVE_LIMIT_USAGE`,
    `10:00:00.000 (${base + 14000})|LIMIT_USAGE_FOR_NS|(default)|`,
    '  Number of SOQL queries: 1 out of 100',
    '  Number of DML statements: 1 out of 150',
    '  Maximum CPU time: 45 out of 10000',
    `10:00:00.000 (${base + 14000})|CUMULATIVE_LIMIT_USAGE_END`,
    `10:00:00.000 (${base + 15000})|CODE_UNIT_FINISHED|apex://DataController/ACTION$load`,
    `10:00:00.000 (${base + 16000})|EXECUTION_FINISHED`,
  ].join('\n');
}

/** Build a ~targetBytes log by repeating the block with monotonic nanos. */
function generateLog(targetBytes: number): { raw: string; blocks: number } {
  const perBlock = block(0).length + 1; // +1 for the joining newline
  const blocks = Math.ceil(targetBytes / perBlock);
  const parts: string[] = [
    '64.0 APEX_CODE,FINEST;APEX_PROFILING,INFO;CALLOUT,INFO;DB,INFO;SYSTEM,FINE',
  ];
  for (let b = 0; b < blocks; b++) parts.push(block(b * 100000));
  return { raw: parts.join('\n'), blocks };
}

describe('extension/lib/apex-log 5MB benchmark (P3-2 PR-3)', () => {
  const { raw, blocks } = generateLog(TARGET_BYTES);
  const megabytes = (raw.length / (1024 * 1024)).toFixed(2);

  it(`parses ~${megabytes} MB (${blocks} executions) synchronously under ${BUDGET_MS}ms`, () => {
    const start = performance.now();
    const parsed = parseApexLog(raw, { collectEvents: false });
    const elapsed = performance.now() - start;

    console.log(
      `[apex-log bench] ${megabytes} MB, ${blocks} executions: sync parse ${elapsed.toFixed(1)}ms (collectEvents:false)`,
    );

    expect(parsed.truncated).toBe(false);
    expect(parsed.tree.length).toBe(blocks); // every execution became a root
    expect(elapsed).toBeLessThan(BUDGET_MS);
  });

  it('collectEvents:false is a real memory lever (drops the flat events[])', () => {
    const withEvents = parseApexLog(raw); // default collectEvents:true
    const withoutEvents = parseApexLog(raw, { collectEvents: false });

    expect(withoutEvents.events).toHaveLength(0);
    // Non-trivial event count without the flag — the memory it saves is real.
    expect(withEvents.events.length).toBeGreaterThan(blocks * 10);
    // The structural result (tree + inventories) is identical either way.
    expect(withoutEvents.tree.length).toBe(withEvents.tree.length);
    expect(withoutEvents.soql.length).toBe(withEvents.soql.length);
  });
});
