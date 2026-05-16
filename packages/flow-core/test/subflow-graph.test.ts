import { describe, it, expect } from 'vitest';
import { buildSubflowGraph, getCallChains } from '../src/subflow-graph.js';
import type { RawFlowMetadata } from '../src/normalize.js';
function withSubflows(name: string, calls: readonly string[]): RawFlowMetadata {
  return {
    label: name,
    processType: 'Flow',
    subflows: calls.map((flowName, i) => ({ name: `sub_${i}`, flowName })),
  };
}
describe('flow-core/subflow-graph', () => {
  describe('buildSubflowGraph', () => {
    it('builds outgoing + incoming edges', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B', 'C']) },
        { id: 'B', metadata: withSubflows('B', ['C']) },
        { id: 'C', metadata: withSubflows('C', []) },
      ]);
      expect(graph.nodes.get('A')!.outgoing.map((e) => e.id)).toEqual(['B', 'C']);
      expect(graph.nodes.get('C')!.incoming.sort()).toEqual(['A', 'B']);
    });
    it('flags edges that point at flows we have no metadata for', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['Missing', 'B']) },
        { id: 'B', metadata: withSubflows('B', []) },
      ]);
      const outgoing = graph.nodes.get('A')!.outgoing;
      expect(outgoing.find((e) => e.id === 'Missing')?.missing).toBe(true);
      expect(outgoing.find((e) => e.id === 'B')?.missing).toBe(false);
      expect(graph.unresolvedReferences).toEqual(['Missing']);
    });
    it('detects a two-flow cycle A → B → A', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['A']) },
      ]);
      expect(graph.cycles).toHaveLength(1);
      expect(graph.cycles[0]!.members).toEqual(['A', 'B']);
    });
    it('detects a self-loop A → A', () => {
      const graph = buildSubflowGraph([
        { id: 'Recursive', metadata: withSubflows('Recursive', ['Recursive']) },
      ]);
      expect(graph.cycles).toHaveLength(1);
      expect(graph.cycles[0]!.members).toEqual(['Recursive']);
    });
    it('detects a three-flow cycle A → B → C → A', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['C']) },
        { id: 'C', metadata: withSubflows('C', ['A']) },
      ]);
      expect(graph.cycles).toHaveLength(1);
      expect(graph.cycles[0]!.members.sort()).toEqual(['A', 'B', 'C']);
    });
    it('does NOT flag a DAG (no cycles)', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B', 'C']) },
        { id: 'B', metadata: withSubflows('B', ['D']) },
        { id: 'C', metadata: withSubflows('C', ['D']) },
        { id: 'D', metadata: withSubflows('D', []) },
      ]);
      expect(graph.cycles).toEqual([]);
    });
    it('flags two independent cycles separately', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['A']) },
        { id: 'X', metadata: withSubflows('X', ['Y']) },
        { id: 'Y', metadata: withSubflows('Y', ['X']) },
      ]);
      expect(graph.cycles).toHaveLength(2);
      expect(graph.cycles[0]!.members).toEqual(['A', 'B']);
      expect(graph.cycles[1]!.members).toEqual(['X', 'Y']);
    });
    it('returns deterministic cycle ordering across runs', () => {
      const a = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['A']) },
      ]);
      const b = buildSubflowGraph([
        { id: 'B', metadata: withSubflows('B', ['A']) },
        { id: 'A', metadata: withSubflows('A', ['B']) },
      ]);
      expect(a.cycles).toEqual(b.cycles);
    });
  });
  describe('maxDepth', () => {
    it('terminal flows have depth 0', () => {
      const graph = buildSubflowGraph([
        { id: 'X', metadata: withSubflows('X', []) },
      ]);
      expect(graph.maxDepth.get('X')).toBe(0);
    });
    it('returns the longest acyclic chain length', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B', 'E']) },
        { id: 'B', metadata: withSubflows('B', ['C']) },
        { id: 'C', metadata: withSubflows('C', ['D']) },
        { id: 'D', metadata: withSubflows('D', []) },
        { id: 'E', metadata: withSubflows('E', []) },
      ]);
      expect(graph.maxDepth.get('A')).toBe(3);
      expect(graph.maxDepth.get('B')).toBe(2);
      expect(graph.maxDepth.get('E')).toBe(0);
    });
    it('keeps depth finite inside a cycle and reports the cycle separately', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['A']) },
      ]);
      const depthA = graph.maxDepth.get('A') ?? -1;
      const depthB = graph.maxDepth.get('B') ?? -1;
      expect(depthA).toBeGreaterThanOrEqual(1);
      expect(depthB).toBeGreaterThanOrEqual(1);
      expect(depthA).toBeLessThanOrEqual(2);
      expect(depthB).toBeLessThanOrEqual(2);
      expect(graph.cycles).toHaveLength(1);
    });
  });
  describe('getCallChains', () => {
    it('emits one chain per leaf path in a DAG', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B', 'C']) },
        { id: 'B', metadata: withSubflows('B', ['D']) },
        { id: 'C', metadata: withSubflows('C', []) },
        { id: 'D', metadata: withSubflows('D', []) },
      ]);
      const chains = getCallChains(graph, 'A');
      expect(chains).toContainEqual(['A', 'B', 'D']);
      expect(chains).toContainEqual(['A', 'C']);
    });
    it('terminates cycles with a "(cycle)" marker', () => {
      const graph = buildSubflowGraph([
        { id: 'A', metadata: withSubflows('A', ['B']) },
        { id: 'B', metadata: withSubflows('B', ['A']) },
      ]);
      const chains = getCallChains(graph, 'A');
      expect(chains.some((c) => c.some((s) => s.includes('(cycle)')))).toBe(true);
    });
    it('returns [] for an unknown id', () => {
      const graph = buildSubflowGraph([]);
      expect(getCallChains(graph, 'NoSuchFlow')).toEqual([]);
    });
    it('caps very long chains with an ellipsis marker', () => {
      const records: Array<{ id: string; metadata: RawFlowMetadata }> = [];
      for (let i = 0; i < 12; i += 1) {
        records.push({
          id: String.fromCharCode(65 + i),
          metadata: withSubflows(String.fromCharCode(65 + i), [String.fromCharCode(66 + i)]),
        });
      }
      const graph = buildSubflowGraph(records);
      const chains = getCallChains(graph, 'A', 4);
      expect(chains[0]![chains[0]!.length - 1]).toBe('…');
    });
  });
});
