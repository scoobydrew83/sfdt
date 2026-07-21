import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseApexLog } from '../lib/apex-log/index.js';
import type { InvocationNode } from '../lib/apex-log/index.js';

// TODO: add 1–2 real captured+scrubbed logs (orchestrator/Drew to supply from synthetic-spark).
const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'apex-log',
);

function load(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

function walk(nodes: InvocationNode[], visit: (n: InvocationNode) => void): void {
  for (const n of nodes) {
    visit(n);
    walk(n.children, visit);
  }
}

function childTotal(node: InvocationNode): number {
  return node.children.reduce((sum, c) => sum + (c.totalNanos ?? 0), 0);
}

describe('extension/lib/apex-log parseApexLog', () => {
  describe('duration invariants (non-truncated fixtures)', () => {
    for (const fixture of [
      'small-happy.log',
      'deep-nesting.log',
      'managed-package.log',
      'soql-dml-heavy.log',
      'limits-heavy.log',
    ]) {
      it(`${fixture}: Σ children.totalNanos ≤ node.totalNanos, self = total − children, self ≥ 0`, () => {
        const parsed = parseApexLog(load(fixture));
        expect(parsed.truncated).toBe(false);
        expect(parsed.tree.length).toBeGreaterThan(0);

        let closedNodes = 0;
        walk(parsed.tree, (node) => {
          expect(node.totalNanos).not.toBeNull();
          expect(node.selfNanos).not.toBeNull();
          closedNodes++;
          const total = node.totalNanos!;
          const children = childTotal(node);
          expect(children).toBeLessThanOrEqual(total);
          expect(node.selfNanos).toBe(total - children);
          expect(node.selfNanos!).toBeGreaterThanOrEqual(0);
        });
        expect(closedNodes).toBeGreaterThan(0);
      });
    }
  });

  describe('small-happy.log', () => {
    const parsed = parseApexLog(load('small-happy.log'));

    it('parses the header apiVersion and debug levels', () => {
      expect(parsed.apiVersion).toBe('64.0');
      expect(parsed.debugLevels.APEX_CODE).toBe('FINEST');
      expect(parsed.debugLevels.SYSTEM).toBe('FINE');
      expect(parsed.debugLevels.WORKFLOW).toBe('INFO');
    });

    it('builds the execution → code-unit → method tree', () => {
      const [root] = parsed.tree;
      expect(root!.kind).toBe('execution');
      const codeUnit = root!.children[0]!;
      expect(codeUnit.kind).toBe('code-unit');
      expect(codeUnit.name).toContain('AccountTrigger');
      expect(codeUnit.children.map((c) => c.kind)).toEqual(['method', 'method']);
      expect(codeUnit.children[0]!.name).toBe(
        'AccountService.validateAccounts(List<Account>)',
      );
    });

    it('captures every event (incl. non-tree tokens) into events[]', () => {
      expect(parsed.events.some((e) => e.type === 'USER_DEBUG')).toBe(true);
      expect(parsed.events.every((e) => e.timestampNanos !== null)).toBe(true);
    });

    it('returns empty PR-2 inventories', () => {
      expect(parsed.limits).toEqual([]);
      expect(parsed.soql).toEqual([]);
      expect(parsed.dml).toEqual([]);
      expect(parsed.callouts).toEqual([]);
    });

    it('honours collectEvents=false', () => {
      const noEvents = parseApexLog(load('small-happy.log'), { collectEvents: false });
      expect(noEvents.events).toEqual([]);
      expect(noEvents.tree.length).toBeGreaterThan(0); // tree still built
    });
  });

  describe('truncated.log', () => {
    const parsed = parseApexLog(load('truncated.log'));

    it('flags truncation with the MAXIMUM reason', () => {
      expect(parsed.truncated).toBe(true);
      expect(parsed.truncationReason).toBe('MAXIMUM_DEBUG_LOG_SIZE_REACHED');
    });

    it('closes dangling frames with null durations + truncated:true', () => {
      const dangling: InvocationNode[] = [];
      walk(parsed.tree, (n) => {
        if (n.truncated) dangling.push(n);
      });
      // EXECUTION + CODE_UNIT + the unclosed recalculateScores method.
      expect(dangling.length).toBeGreaterThanOrEqual(3);
      for (const n of dangling) {
        expect(n.totalNanos).toBeNull();
        expect(n.selfNanos).toBeNull();
        expect(n.exitLine).toBeNull();
      }
      const method = dangling.find((n) => n.kind === 'method');
      expect(method!.name).toContain('recalculateScores');
    });

    it('still closes the balanced method before the cut', () => {
      let synced: InvocationNode | undefined;
      walk(parsed.tree, (n) => {
        if (n.name.includes('syncContacts')) synced = n;
      });
      expect(synced!.truncated).toBeUndefined();
      expect(synced!.totalNanos).toBe(1000); // 4000 − 3000
    });

    it('never throws and keeps everything parsed before the cut', () => {
      expect(() => parseApexLog(load('truncated.log'))).not.toThrow();
      expect(parsed.apiVersion).toBe('64.0');
      expect(parsed.events.some((e) => e.type === 'SOQL_EXECUTE_BEGIN')).toBe(true);
    });
  });

  describe('inventory truncation recovery', () => {
    it('does not misattribute a post-gap SOQL_END to a pre-gap pending BEGIN', () => {
      // The pre-gap query's END is eaten by the skip; a later, unrelated END must
      // NOT pop the stale pending entry and set its rows — it stays null.
      const raw = [
        '64.0 APEX_CODE,FINEST',
        '10:00:00.0 (1000)|EXECUTION_STARTED',
        "10:00:00.1 (2000)|SOQL_EXECUTE_BEGIN|[1]|SELECT Id FROM Account",
        '*** Skipped 500 bytes of detailed log',
        '10:00:00.3 (4000)|SOQL_EXECUTE_END|[9]|Rows:99',
        '10:00:00.4 (5000)|EXECUTION_FINISHED',
      ].join('\n');
      const parsed = parseApexLog(raw);
      expect(parsed.truncated).toBe(true);
      expect(parsed.truncationReason).toBe('SKIPPED_BYTES');
      expect(parsed.soql).toHaveLength(1);
      expect(parsed.soql[0]!.rows).toBeNull(); // NOT 99
    });
  });

  describe('inventories (soql-dml-heavy.log)', () => {
    const parsed = parseApexLog(load('soql-dml-heavy.log'));

    it('collects one SOQL entry with query, rows, 0-based line, enclosing node', () => {
      expect(parsed.soql).toHaveLength(1);
      const [q] = parsed.soql;
      expect(q!.query).toBe("SELECT Id, Name FROM Account WHERE Industry = 'Tech'");
      expect(q!.rows).toBe(12);
      expect(q!.line).toBe(4); // 0-based raw-body line of SOQL_EXECUTE_BEGIN (matches events/nodes)
      expect(q!.node!.name).toBe('DataService.loadAccounts()');
      expect(q!.node!.kind).toBe('method');
    });

    it('collects one DML entry with op + sobject + rows + node', () => {
      expect(parsed.dml).toHaveLength(1);
      const [d] = parsed.dml;
      expect(d!.op).toBe('Insert');
      expect(d!.sobject).toBe('Account');
      expect(d!.rows).toBe(3);
      expect(d!.line).toBe(6);
      expect(d!.node!.name).toBe('DataService.loadAccounts()');
    });

    it('collects one callout entry with method + endpoint + status + node', () => {
      expect(parsed.callouts).toHaveLength(1);
      const [c] = parsed.callouts;
      expect(c!.method).toBe('POST');
      expect(c!.endpoint).toBe('https://api.example.com/v1/accounts');
      expect(c!.status).toBe('OK');
      expect(c!.line).toBe(10);
      expect(c!.node!.name).toBe('IntegrationService.push()'); // the SECOND method
    });
  });

  describe('limits (managed-package.log)', () => {
    const parsed = parseApexLog(load('managed-package.log'));

    it('attributes the managed namespace to the tree node', () => {
      let node: InvocationNode | undefined;
      walk(parsed.tree, (n) => {
        if (n.name.startsWith('myns.Service')) node = n;
      });
      expect(node!.namespace).toBe('myns');
    });

    it('captures the myns limit snapshot with mapped metric keys', () => {
      expect(parsed.limits).toHaveLength(1);
      const [snap] = parsed.limits;
      expect(snap!.namespace).toBe('myns');
      expect(snap!.cumulative).toBe(true);
      expect(snap!.metrics.soqlQueries).toEqual({ used: 2, max: 100 });
      expect(snap!.metrics.queryRows).toEqual({ used: 15, max: 50000 });
      expect(snap!.metrics.dmlStatements).toEqual({ used: 1, max: 150 });
      expect(snap!.metrics.cpuTime).toEqual({ used: 45, max: 10000 });
      expect(snap!.metrics.heapSize).toEqual({ used: 0, max: 6000000 });
    });
  });

  describe('limits (limits-heavy.log)', () => {
    const parsed = parseApexLog(load('limits-heavy.log'));

    it('keeps per-namespace snapshots in document order', () => {
      expect(parsed.limits.map((l) => l.namespace)).toEqual([
        '(default)',
        'myns',
        '(default)',
        'myns',
      ]);
      expect(parsed.limits.every((l) => l.cumulative)).toBe(true);
    });

    // Invariant 3: for each namespace+metric, `used` is non-decreasing across
    // successive snapshots, and every `used ≤ max`.
    it('used is monotonic non-decreasing per namespace+metric, and used ≤ max', () => {
      const seen = new Map<string, number>();
      for (const snap of parsed.limits) {
        for (const [metric, pair] of Object.entries(snap.metrics)) {
          expect(pair.used).toBeLessThanOrEqual(pair.max);
          const key = `${snap.namespace}::${metric}`;
          const prev = seen.get(key);
          if (prev !== undefined) {
            expect(pair.used).toBeGreaterThanOrEqual(prev);
          }
          seen.set(key, pair.used);
        }
      }
      // The fixture must actually exercise growth, not just be trivially flat.
      expect(seen.get('(default)::soqlQueries')).toBe(4);
      expect(seen.get('myns::soqlQueries')).toBe(3);
    });
  });

  describe('robustness', () => {
    it('does not throw on empty or garbage input', () => {
      expect(() => parseApexLog('')).not.toThrow();
      expect(() => parseApexLog('not a log\nrandom noise')).not.toThrow();
      expect(parseApexLog('').tree).toEqual([]);
    });
  });
});
