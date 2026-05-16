import type { RawFlowMetadata } from './normalize.js';
export interface SubflowGraphCandidate {
  id: string;
  label?: string;
  metadata: RawFlowMetadata;
}
export interface SubflowGraphNode {
  id: string;
  label: string;
  outgoing: Array<{ id: string; missing: boolean }>;
  incoming: string[];
}
export interface SubflowCycle {
  members: string[];
}
export interface SubflowGraph {
  nodes: Map<string, SubflowGraphNode>;
  cycles: SubflowCycle[];
  maxDepth: Map<string, number>;
  unresolvedReferences: string[];
}
function extractSubflowTargets(metadata: RawFlowMetadata): string[] {
  const subflows = metadata.subflows;
  if (!Array.isArray(subflows)) return [];
  const names: string[] = [];
  for (const entry of subflows) {
    const flowName = (entry as { flowName?: unknown }).flowName;
    if (typeof flowName === 'string' && flowName.trim()) names.push(flowName.trim());
  }
  return names;
}
function tarjanCycles(nodes: Map<string, SubflowGraphNode>): SubflowCycle[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  function strongconnect(start: string): void {
    type Frame = { id: string; iterator: Iterator<{ id: string; missing: boolean }> };
    const callStack: Frame[] = [{ id: start, iterator: nodes.get(start)!.outgoing[Symbol.iterator]() }];
    indices.set(start, index);
    lowlink.set(start, index);
    index += 1;
    stack.push(start);
    onStack.add(start);
    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const next = frame.iterator.next();
      if (next.done) {
        const id = frame.id;
        if (lowlink.get(id) === indices.get(id)) {
          const scc: string[] = [];
          while (true) {
            const w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
            if (w === id) break;
          }
          sccs.push(scc);
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          lowlink.set(parent.id, Math.min(lowlink.get(parent.id)!, lowlink.get(id)!));
        }
        continue;
      }
      const childId = next.value.id;
      if (!nodes.has(childId)) continue;
      if (!indices.has(childId)) {
        indices.set(childId, index);
        lowlink.set(childId, index);
        index += 1;
        stack.push(childId);
        onStack.add(childId);
        callStack.push({ id: childId, iterator: nodes.get(childId)!.outgoing[Symbol.iterator]() });
      } else if (onStack.has(childId)) {
        lowlink.set(frame.id, Math.min(lowlink.get(frame.id)!, indices.get(childId)!));
      }
    }
  }
  for (const id of nodes.keys()) {
    if (!indices.has(id)) strongconnect(id);
  }
  const cycles: SubflowCycle[] = [];
  for (const scc of sccs) {
    if (scc.length > 1) {
      const sorted = [...scc].sort();
      cycles.push({ members: rotateToMin(sorted) });
      continue;
    }
    const only = scc[0]!;
    const hasSelfLoop = nodes.get(only)!.outgoing.some((e) => e.id === only);
    if (hasSelfLoop) cycles.push({ members: [only] });
  }
  cycles.sort((a, b) => (a.members[0] ?? '').localeCompare(b.members[0] ?? ''));
  return cycles;
}
function rotateToMin(arr: readonly string[]): string[] {
  if (arr.length === 0) return [];
  let minIdx = 0;
  for (let i = 1; i < arr.length; i += 1) {
    if ((arr[i] ?? '') < (arr[minIdx] ?? '')) minIdx = i;
  }
  return [...arr.slice(minIdx), ...arr.slice(0, minIdx)];
}
function computeMaxDepths(nodes: Map<string, SubflowGraphNode>): Map<string, number> {
  const memo = new Map<string, number>();
  function depthOf(id: string, visiting: Set<string>): number {
    if (memo.has(id)) return memo.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let max = 0;
    const node = nodes.get(id);
    if (node) {
      for (const edge of node.outgoing) {
        if (!nodes.has(edge.id)) continue;
        const sub = depthOf(edge.id, visiting) + 1;
        if (sub > max) max = sub;
      }
    }
    visiting.delete(id);
    memo.set(id, max);
    return max;
  }
  for (const id of nodes.keys()) depthOf(id, new Set());
  return memo;
}
export function buildSubflowGraph(candidates: readonly SubflowGraphCandidate[]): SubflowGraph {
  const nodes = new Map<string, SubflowGraphNode>();
  for (const c of candidates) {
    nodes.set(c.id, {
      id: c.id,
      label: c.label ?? c.id,
      outgoing: [],
      incoming: [],
    });
  }
  const unresolved = new Set<string>();
  for (const c of candidates) {
    const targets = extractSubflowTargets(c.metadata);
    const node = nodes.get(c.id)!;
    for (const target of targets) {
      const exists = nodes.has(target);
      node.outgoing.push({ id: target, missing: !exists });
      if (exists) {
        nodes.get(target)!.incoming.push(c.id);
      } else {
        unresolved.add(target);
      }
    }
  }
  const cycles = tarjanCycles(nodes);
  const maxDepth = computeMaxDepths(nodes);
  return {
    nodes,
    cycles,
    maxDepth,
    unresolvedReferences: Array.from(unresolved).sort(),
  };
}
export function getCallChains(
  graph: SubflowGraph,
  fromId: string,
  maxLength = 8,
): string[][] {
  const root = graph.nodes.get(fromId);
  if (!root) return [];
  const chains: string[][] = [];
  function walk(path: readonly string[]): void {
    if (path.length > maxLength) {
      chains.push([...path, '…']);
      return;
    }
    const current = graph.nodes.get(path[path.length - 1]!);
    if (!current || current.outgoing.length === 0) {
      if (path.length > 1) chains.push([...path]);
      return;
    }
    let extended = false;
    for (const edge of current.outgoing) {
      if (path.includes(edge.id)) {
        chains.push([...path, `${edge.id} (cycle)`]);
        continue;
      }
      extended = true;
      walk([...path, edge.id]);
    }
    if (!extended && path.length > 1) chains.push([...path]);
  }
  walk([fromId]);
  return chains;
}
