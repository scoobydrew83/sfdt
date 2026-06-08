import { execa } from 'execa';
import { detectTriggerConflicts, buildSubflowGraph } from '@sfdt/flow-core';
import { runFlowQuality } from './flow-quality.js';

const METADATA_FETCH_CONCURRENCY = 5;
const ORG_ALIAS_RE = /^[A-Za-z0-9@][A-Za-z0-9_.\-@]*$/;
const ORG_ALIAS_MAX_LEN = 80;

function assertValidOrgAlias(orgAlias) {
  if (
    typeof orgAlias !== 'string' ||
    orgAlias.length === 0 ||
    orgAlias.length > ORG_ALIAS_MAX_LEN ||
    !ORG_ALIAS_RE.test(orgAlias)
  ) {
    throw new Error(`Invalid org alias: "${orgAlias}"`);
  }
}

async function toolingQuery(orgAlias, soql) {
  assertValidOrgAlias(orgAlias);
  const result = await execa(
    'sf',
    ['data', 'query', '--use-tooling-api', '-q', soql, '--json', '--target-org', orgAlias],
    { reject: true },
  );
  return JSON.parse(result.stdout);
}

function escapeSoqlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export async function listFlowDefinitions(orgAlias) {
  const soql =
    'SELECT Id, DeveloperName, ActiveVersionId FROM FlowDefinition ' +
    'WHERE ActiveVersionId != null ORDER BY DeveloperName ASC';
  const result = await toolingQuery(orgAlias, soql);
  return result.result?.records ?? [];
}

export async function fetchActiveVersion(orgAlias, activeVersionId) {
  const soql =
    'SELECT Id, MasterLabel, Description, Status, VersionNumber, LastModifiedDate, Metadata ' +
    `FROM Flow WHERE Id = '${escapeSoqlString(activeVersionId)}'`;
  const result = await toolingQuery(orgAlias, soql);
  return result.result?.records?.[0] ?? null;
}

async function inParallel(items, concurrency, worker) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  });
  await Promise.all(runners);
}

export async function runFlowScan(orgAlias, currentApiVersion) {
  const definitions = await listFlowDefinitions(orgAlias);
  const reports = [];
  const errors = [];

  await inParallel(definitions, METADATA_FETCH_CONCURRENCY, async (def) => {
    try {
      const record = await fetchActiveVersion(orgAlias, def.ActiveVersionId);
      if (!record?.Metadata) return;

      const { meta, summary, issueFamilies } = runFlowQuality(record.Metadata, {
        flowVersionId: record.Id,
        flowApiName: def.DeveloperName,
        currentApiVersion,
      });

      reports.push({
        flowDefinitionId: def.Id,
        flowVersionId: record.Id,
        developerName: def.DeveloperName,
        label: record.MasterLabel ?? def.DeveloperName,
        flowType: meta.flowType,
        apiVersion: meta.apiVersion,
        status: meta.status,
        overallScore: summary.overallScore,
        rating: summary.rating,
        severityCounts: summary.severityCounts,
        categoryCounts: summary.categoryCounts,
        issueFamilyCount: issueFamilies.length,
        issueFamilies,
      });
    } catch (err) {
      errors.push({
        flowDefinitionId: def.Id,
        developerName: def.DeveloperName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  reports.sort((a, b) => a.overallScore - b.overallScore);

  return {
    timestamp: new Date().toISOString(),
    org: orgAlias,
    totalFlows: reports.length,
    totalErrors: errors.length,
    averageScore:
      reports.length > 0
        ? Math.round(reports.reduce((sum, r) => sum + r.overallScore, 0) / reports.length)
        : null,
    reports,
    errors,
  };
}

export async function runFlowConflicts(orgAlias) {
  const definitions = await listFlowDefinitions(orgAlias);
  const candidates = [];
  const errors = [];

  await inParallel(definitions, METADATA_FETCH_CONCURRENCY, async (def) => {
    try {
      const record = await fetchActiveVersion(orgAlias, def.ActiveVersionId);
      if (!record?.Metadata) return;
      candidates.push({
        flowId: def.DeveloperName,
        label: record.MasterLabel ?? def.DeveloperName,
        metadata: record.Metadata,
      });
    } catch (err) {
      errors.push({
        flowDefinitionId: def.Id,
        developerName: def.DeveloperName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const groups = detectTriggerConflicts(candidates);

  return {
    timestamp: new Date().toISOString(),
    org: orgAlias,
    totalGroups: groups.length,
    totalFlowsInConflicts: groups.reduce((n, g) => n + g.flows.length, 0),
    groups,
    errors,
  };
}

export async function runFlowGraph(orgAlias) {
  const definitions = await listFlowDefinitions(orgAlias);
  const candidates = [];
  const errors = [];

  await inParallel(definitions, METADATA_FETCH_CONCURRENCY, async (def) => {
    try {
      const record = await fetchActiveVersion(orgAlias, def.ActiveVersionId);
      if (!record?.Metadata) return;
      candidates.push({
        id: def.DeveloperName,
        label: record.MasterLabel ?? def.DeveloperName,
        metadata: record.Metadata,
      });
    } catch (err) {
      errors.push({
        flowDefinitionId: def.Id,
        developerName: def.DeveloperName,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  const graph = buildSubflowGraph(candidates);

  // Compile Mermaid flowchart string
  const mermaidLines = ['flowchart TD'];
  const nodesMap = {};
  
  for (const [id, node] of graph.nodes.entries()) {
    const cleanLabel = (node.label ?? id).replace(/"/g, '\\"');
    mermaidLines.push(`  ${id}["${cleanLabel}"]`);
    nodesMap[id] = {
      id: node.id,
      label: node.label,
      outgoing: node.outgoing,
      incoming: node.incoming,
      maxDepth: graph.maxDepth.get(id) ?? 0,
      inCycle: graph.cycles.some(c => c.members.includes(id)),
    };
  }

  for (const [id, node] of graph.nodes.entries()) {
    for (const edge of node.outgoing) {
      if (edge.missing) {
        mermaidLines.push(`  ${id} -.-> ${edge.id}:::missing`);
      } else {
        mermaidLines.push(`  ${id} --> ${edge.id}`);
      }
    }
  }

  if (graph.cycles.length > 0) {
    const cycleNodes = new Set(graph.cycles.flatMap(c => c.members));
    for (const cycleNode of cycleNodes) {
      mermaidLines.push(`  style ${cycleNode} stroke:#ff0000,stroke-width:2px;`);
    }
  }

  mermaidLines.push('  classDef missing stroke:#ff3333,stroke-dasharray: 5 5;');

  return {
    timestamp: new Date().toISOString(),
    org: orgAlias,
    nodes: nodesMap,
    cycles: graph.cycles.map(c => c.members),
    unresolvedReferences: graph.unresolvedReferences,
    mermaid: mermaidLines.join('\n'),
    errors,
  };
}
