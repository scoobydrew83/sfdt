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
    for (const fixture of ['small-happy.log', 'deep-nesting.log']) {
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

  describe('robustness', () => {
    it('does not throw on empty or garbage input', () => {
      expect(() => parseApexLog('')).not.toThrow();
      expect(() => parseApexLog('not a log\nrandom noise')).not.toThrow();
      expect(parseApexLog('').tree).toEqual([]);
    });
  });
});
