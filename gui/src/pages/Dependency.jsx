import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api.js';
import { GRAPH_SOURCE_TYPES, METADATA_TYPES } from '@sfdt/flow-core';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
} from 'd3-force';
import { select } from 'd3-selection';
import { zoom as d3Zoom, zoomIdentity as d3ZoomIdentity } from 'd3-zoom';
import { drag as d3Drag } from 'd3-drag';

// ─── Color map by metadata type (GUI-only; flow-core stays styling-free) ─────
const TYPE_COLORS = {
  ApexClass:                'var(--brand-500)',
  ApexTrigger:              'var(--status-modified-solid)',
  ApexPage:                 'var(--accent-500)',
  ApexComponent:            'var(--status-source-solid)',
  Flow:                     'var(--status-identical-solid)',
  LightningComponentBundle: 'var(--brand-300)',
  AuraDefinitionBundle:     'var(--accent-600)',
  CustomObject:             'var(--status-conflict-solid)',
  CustomField:              'var(--status-target-solid)',
};

// Selectable source types + labels come from flow-core so CLI/GUI never drift.
const ALL_TYPES = GRAPH_SOURCE_TYPES.map((t) => t.type);
const TYPE_LABELS = Object.fromEntries(GRAPH_SOURCE_TYPES.map((t) => [t.type, t.label]));
const DEFAULT_ON_TYPES = GRAPH_SOURCE_TYPES.filter((t) => t.graphDefaultOn).map((t) => t.type);

// Seed types must be name-resolvable (CustomObject has no resolver — reachable only via expansion).
const SEED_TYPES = METADATA_TYPES;

function typeColor(type) {
  return TYPE_COLORS[type] ?? 'var(--fg-muted)';
}

function shortName(name) {
  if (!name) return '';
  const idx = name.indexOf('__');
  return idx !== -1 ? name.slice(idx + 2) : name;
}

function pillClass(type) {
  switch (type) {
    case 'ApexClass':     return 'status-pill pill-add';
    case 'ApexTrigger':   return 'status-pill pill-mod';
    case 'ApexComponent': return 'status-pill pill-match';
    case 'Flow':          return 'status-pill pill-conflict';
    default:              return 'status-pill pill-match';
  }
}

// ─── Detail Rail ─────────────────────────────────────────────────────────────
function DetailRail({ selected, nodes, onSelectNode, onClear }) {
  if (!selected) {
    return (
      <aside className="graph-rail">
        <div className="rail-empty">
          <svg viewBox="0 0 13 13" fill="none" stroke="currentColor" strokeWidth="1.4" width="28" height="28" style={{ opacity: 0.3 }}>
            <circle cx="6.5" cy="6.5" r="2"/>
            <line x1="6.5" y1="1" x2="6.5" y2="4"/>
            <line x1="6.5" y1="9" x2="6.5" y2="12"/>
            <line x1="1" y1="6.5" x2="4" y2="6.5"/>
            <line x1="9" y1="6.5" x2="12" y2="6.5"/>
          </svg>
          Click any node to explore its dependencies
        </div>
      </aside>
    );
  }

  const nodeMap = Object.fromEntries(nodes.map((n) => [n.id, n]));

  const dependsOn = (selected.deps ?? []).map((id) => nodeMap[id]).filter(Boolean);
  const usedBy    = (selected.refs ?? []).map((id) => nodeMap[id]).filter(Boolean);

  return (
    <aside className="graph-rail">
      <div className="rail-node-hdr">
        <div className="rail-node-name">{selected.name}</div>
        <div style={{ marginTop: 6 }}>
          <span className={pillClass(selected.type)}>{selected.type}</span>
        </div>
      </div>

      <div className="rail-section">
        <div className="rail-section-lbl">Depends on ({dependsOn.length})</div>
        {dependsOn.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>None</div>
        )}
        {dependsOn.map((n) => (
          <div
            key={n.id}
            className="rail-dep-item"
            onClick={() => onSelectNode(n.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelectNode(n.id)}
          >
            <span className="rail-dep-dot" style={{ background: typeColor(n.type) }} />
            {shortName(n.name)}
          </div>
        ))}
      </div>

      <div className="rail-section">
        <div className="rail-section-lbl">Used by ({usedBy.length})</div>
        {usedBy.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>None</div>
        )}
        {usedBy.map((n) => (
          <div
            key={n.id}
            className="rail-dep-item"
            onClick={() => onSelectNode(n.id)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && onSelectNode(n.id)}
          >
            <span className="rail-dep-dot" style={{ background: typeColor(n.type) }} />
            {shortName(n.name)}
          </div>
        ))}
      </div>

      <div className="rail-actions">
        <button
          className="btn btn-ghost"
          style={{ fontSize: 11, width: '100%' }}
          type="button"
          onClick={() => navigator.clipboard?.writeText(`${selected.type}:${selected.name}`)}
        >
          Copy component name
        </button>
        <button
          className="btn-link"
          style={{ fontSize: 11, color: 'var(--fg-muted)' }}
          onClick={onClear}
        >
          Clear selection
        </button>
      </div>
    </aside>
  );
}

// ─── D3 Graph Canvas ─────────────────────────────────────────────────────────
export default function Dependency() {
  const [orgs, setOrgs]               = useState([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [activeTypes, setActiveTypes] = useState(new Set(DEFAULT_ON_TYPES));
  const [seedName, setSeedName]       = useState('');
  const [seedType, setSeedType]       = useState(SEED_TYPES[0]);
  const [busy, setBusy]               = useState(false);
  const [error, setError]             = useState(null);
  const [notFound, setNotFound]       = useState(null);
  const [graphData, setGraphData]     = useState(null); // { nodes, edges }
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  const [nodeMeta, setNodeMeta]       = useState(() => new Map()); // id -> { references, referencedBy }
  const [selectedId, setSelectedId]   = useState(null);
  const [enrichedNodes, setEnrichedNodes] = useState([]);
  const [showGaps, setShowGaps]       = useState(false);
  const [gaps, setGaps]               = useState(null);
  const [gapsBusy, setGapsBusy]       = useState(false);

  const svgRef       = useRef(null);
  const simRef       = useRef(null);
  const gRef         = useRef(null);   // <g> wrapper inside SVG
  const nodesDataRef = useRef([]);
  const edgesDataRef = useRef([]);
  const selectedIdRef = useRef(null);
  const zoomRef       = useRef(null);
  const positionsRef  = useRef(new Map()); // id -> {x,y,fx,fy}: preserved across rebuilds so expand doesn't reshuffle
  const expandedIdsRef = useRef(expandedIds);
  const nodeMetaRef    = useRef(nodeMeta);
  const nodeClickRef   = useRef(() => {});

  expandedIdsRef.current = expandedIds;
  nodeMetaRef.current = nodeMeta;

  // Load orgs on mount
  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setSelectedOrg(list[0].alias);
      })
      .catch(() => {});
  }, []);

  // Toggle a type filter chip
  const toggleType = useCallback((t) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);

  // Enrich nodes with adjacency info for the detail rail
  useEffect(() => {
    if (!graphData) { setEnrichedNodes([]); return; }
    const { nodes, edges } = graphData;
    // Build adjacency: deps = outgoing edges (this → target), refs = incoming edges (source → this)
    const deps = {};
    const refs = {};
    nodes.forEach((n) => { deps[n.id] = []; refs[n.id] = []; });
    edges.forEach(({ source, target }) => {
      const sid = typeof source === 'object' ? source.id : source;
      const tid = typeof target === 'object' ? target.id : target;
      if (deps[sid]) deps[sid].push(tid);
      if (refs[tid]) refs[tid].push(sid);
    });
    setEnrichedNodes(nodes.map((n) => ({ ...n, deps: deps[n.id] ?? [], refs: refs[n.id] ?? [] })));
  }, [graphData]);

  // Re-filter visible nodes/edges when activeTypes changes (without re-running simulation)
  useEffect(() => {
    if (!nodesDataRef.current.length) return;
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const g = select(svgEl).select('g.zoom-group');
    g.selectAll('circle').attr('opacity', (d) => activeTypes.has(d.type) ? 1 : 0);
    g.selectAll('text').attr('opacity', (d) => activeTypes.has(d.type) ? 1 : 0);
    g.selectAll('line').attr('opacity', (d) => {
      const srcNode = nodesDataRef.current.find((n) => n.id === (d.source?.id ?? d.source));
      const tgtNode = nodesDataRef.current.find((n) => n.id === (d.target?.id ?? d.target));
      return (srcNode && activeTypes.has(srcNode.type) && tgtNode && activeTypes.has(tgtNode.type)) ? 0.25 : 0;
    });
  }, [activeTypes]);

  // Merge an incoming { nodes, edges } into the accumulated graph (dedupe by id / source|target).
  const mergeGraph = useCallback((prev, incoming, centerNode) => {
    const base = prev ?? { nodes: [], edges: [] };
    const nodes = new Map(base.nodes.map((n) => [n.id, n]));
    if (centerNode && !nodes.has(centerNode.id)) nodes.set(centerNode.id, centerNode);
    for (const n of incoming.nodes ?? []) if (!nodes.has(n.id)) nodes.set(n.id, n);
    const key = (e) => `${e.source}|${e.target}`;
    const edges = new Map(base.edges.map((e) => [key(e), { source: e.source, target: e.target }]));
    for (const e of incoming.edges ?? []) if (!edges.has(key(e))) edges.set(key(e), { source: e.source, target: e.target });
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }, []);

  const recordMeta = useCallback((id, data) => {
    setNodeMeta((prev) => {
      const m = new Map(prev);
      m.set(id, { references: data.references, referencedBy: data.referencedBy });
      return m;
    });
  }, []);

  const addSeed = useCallback(async () => {
    const name = seedName.trim();
    if (!selectedOrg || !name) return;
    setBusy(true); setError(null); setNotFound(null);
    try {
      const r = await api.resolveDependency(selectedOrg, name, seedType);
      if (!r.found) {
        setNotFound(`No ${TYPE_LABELS[seedType] ?? seedType} named "${name}" in ${selectedOrg}`);
        return;
      }
      const seedNode = { id: r.id, name: r.name, type: r.type };
      const data = await api.dependencyNeighbors(selectedOrg, r.id);
      setGraphData((prev) => mergeGraph(prev, data, seedNode));
      setExpandedIds((prev) => new Set(prev).add(r.id));
      recordMeta(r.id, data);
      setSeedName('');
    } catch (err) {
      setError(err.message ?? 'Failed to add seed');
    } finally {
      setBusy(false);
    }
  }, [selectedOrg, seedName, seedType, mergeGraph, recordMeta]);

  const expandNode = useCallback(async (id) => {
    if (!selectedOrg || expandedIdsRef.current.has(id)) return;
    setBusy(true); setError(null);
    try {
      const data = await api.dependencyNeighbors(selectedOrg, id);
      setGraphData((prev) => mergeGraph(prev, data, null));
      setExpandedIds((prev) => new Set(prev).add(id));
      recordMeta(id, data);
    } catch (err) {
      setError(err.message ?? 'Failed to expand node');
    } finally {
      setBusy(false);
    }
  }, [selectedOrg, mergeGraph, recordMeta]);

  const loadGaps = useCallback(async () => {
    const name = seedName.trim();
    if (!name) return;
    setGapsBusy(true);
    try {
      const data = await api.dependencyGaps(selectedOrg || undefined, name, seedType);
      setGaps(data.gaps ?? []);
    } catch (err) {
      setError(err.message ?? 'Gap report failed');
      setGaps([]);
    } finally { setGapsBusy(false); }
  }, [selectedOrg, seedName, seedType]);

  const toggleGaps = useCallback(() => {
    setShowGaps((on) => {
      const next = !on;
      if (next) loadGaps();
      return next;
    });
  }, [loadGaps]);

  const reapplyHighlight = useCallback((focusId) => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    const svg = select(svgEl);
    applyHighlight(svg.selectAll('g.node-g'), svg.selectAll('g.links line'),
      nodesDataRef.current, edgesDataRef.current, focusId);
  }, []);

  nodeClickRef.current = (id) => {
    if (expandedIdsRef.current.has(id)) {
      const next = selectedIdRef.current === id ? null : id;
      selectedIdRef.current = next;
      setSelectedId(next);
      reapplyHighlight(next);
    } else {
      selectedIdRef.current = id;
      setSelectedId(id);
      expandNode(id);
    }
  };

  // ── Build / rebuild D3 simulation whenever graphData changes ───────────────
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;

    // Stop any previous simulation
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }

    // Clear SVG
    select(svgEl).selectAll('*').remove();

    if (!graphData || !graphData.nodes.length) return;

    const { nodes: rawNodes, edges: rawEdges } = graphData;

    // Deep-copy so D3 can mutate x/y without corrupting state. Seed each node's
    // position from the last simulation so an expand keeps existing nodes in place
    // (new nodes have no stored position and get laid out fresh).
    const nodes = rawNodes.map((n) => {
      const p = positionsRef.current.get(n.id);
      return p ? { ...n, x: p.x, y: p.y, fx: p.fx, fy: p.fy } : { ...n };
    });
    const edges = rawEdges.map((e) => ({ ...e }));

    nodesDataRef.current = nodes;
    edgesDataRef.current = edges;

    const width  = svgEl.clientWidth  || 800;
    const height = svgEl.clientHeight || 600;

    const svg = select(svgEl);

    // Arrow marker
    svg.append('defs').append('marker')
      .attr('id', 'dep-arrow')
      .attr('viewBox', '0 -4 8 8')
      .attr('refX', 14)
      .attr('refY', 0)
      .attr('markerWidth', 6)
      .attr('markerHeight', 6)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', 'var(--fg-muted)')
      .attr('opacity', 0.35);

    // Zoom group
    const g = svg.append('g').attr('class', 'zoom-group');
    gRef.current = g;

    // Zoom behaviour
    const zoomBehavior = d3Zoom()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);

    // Link layer
    const linkSel = g.append('g').attr('class', 'links')
      .selectAll('line')
      .data(edges)
      .join('line')
      .attr('stroke', 'var(--fg-muted)')
      .attr('stroke-opacity', 0.2)
      .attr('stroke-width', 1)
      .attr('marker-end', 'url(#dep-arrow)');

    // Drag behaviour
    const dragBehavior = d3Drag()
      .on('start', (event, d) => {
        if (!event.active) simRef.current?.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event) => {
        if (!event.active) simRef.current?.alphaTarget(0);
        // Keep pinned — user double-clicks to unpin
      });

    // Node group
    const nodeGroup = g.append('g').attr('class', 'nodes')
      .selectAll('g.node-g')
      .data(nodes)
      .join('g')
      .attr('class', 'node-g')
      .style('cursor', 'pointer')
      .call(dragBehavior);

    nodeGroup.append('circle')
      .attr('r', 6)
      .attr('fill', (d) => typeColor(d.type))
      .attr('stroke', 'var(--bg-app)')
      .attr('stroke-width', 1.5);

    nodeGroup.append('text')
      .text((d) => shortName(d.name))
      .attr('y', 17)
      .attr('text-anchor', 'middle')
      .attr('font-size', '9px')
      .attr('fill', 'var(--fg-muted)')
      .attr('pointer-events', 'none')
      .attr('font-family', 'var(--font-mono)');

    // Unexpanded nodes get a dashed outer ring signalling "click to expand".
    nodeGroup.filter((d) => !expandedIdsRef.current.has(d.id))
      .append('circle')
      .attr('r', 10)
      .attr('fill', 'none')
      .attr('stroke', (d) => typeColor(d.type))
      .attr('stroke-width', 1)
      .attr('stroke-dasharray', '2 2')
      .attr('opacity', 0.6);

    // Hub badge: a node whose expand hit the cap in either direction.
    nodeGroup.filter((d) => {
      const m = nodeMetaRef.current.get(d.id);
      return m && (m.references?.hasMore || m.referencedBy?.hasMore);
    })
      .append('text')
      .attr('class', 'graph-more-badge')
      .text('+more')
      .attr('x', 11)
      .attr('y', -8)
      .attr('font-size', '8px')
      .attr('fill', 'var(--status-conflict-fg)')
      .attr('font-family', 'var(--font-mono)');

    // Click to select / expand
    nodeGroup.on('click', (event, d) => {
      event.stopPropagation();
      nodeClickRef.current(d.id);
    });

    // Double-click to unpin
    nodeGroup.on('dblclick', (event, d) => {
      event.stopPropagation();
      d.fx = null;
      d.fy = null;
    });

    // Click on SVG background to deselect
    svg.on('click', () => {
      selectedIdRef.current = null;
      setSelectedId(null);
      applyHighlight(nodeGroup, linkSel, nodes, edges, null);
    });

    // Simulation. If most nodes already have positions (an expand, not a first
    // seed), start with a low alpha so settled nodes barely move and only the new
    // ones find a spot, instead of re-energising the whole layout.
    const hasPriorPositions = nodes.some((n) => n.x != null);
    const sim = forceSimulation(nodes)
      .force('link', forceLink(edges).id((d) => d.id).distance(60))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(14))
      .alpha(hasPriorPositions ? 0.3 : 1)
      .on('tick', () => {
        linkSel
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);

        nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
        // Remember positions (incl. drag pins) for the next rebuild.
        for (const d of nodes) {
          positionsRef.current.set(d.id, { x: d.x, y: d.y, fx: d.fx ?? null, fy: d.fy ?? null });
        }
      });

    simRef.current = sim;

    // Re-apply highlight for the selected node after a rebuild (e.g. after an expand).
    if (selectedIdRef.current) {
      applyHighlight(nodeGroup, linkSel, nodes, edges, selectedIdRef.current);
    }

    return () => {
      sim.stop();
      svg.on('click', null);
    };
  }, [graphData]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Highlight helper ────────────────────────────────────────────────────────
  function applyHighlight(nodeGroup, linkSel, _nodes, edges, focusId) {
    if (!focusId) {
      nodeGroup.attr('opacity', 1);
      linkSel.attr('stroke-opacity', 0.2);
      return;
    }

    const neighbors = new Set([focusId]);
    edges.forEach(({ source, target }) => {
      const sid = typeof source === 'object' ? source.id : source;
      const tid = typeof target === 'object' ? target.id : target;
      if (sid === focusId) neighbors.add(tid);
      if (tid === focusId) neighbors.add(sid);
    });

    nodeGroup.attr('opacity', (d) => (neighbors.has(d.id) ? 1 : 0.15));
    linkSel.attr('stroke-opacity', (d) => {
      const sid = typeof d.source === 'object' ? d.source.id : d.source;
      const tid = typeof d.target === 'object' ? d.target.id : d.target;
      return (sid === focusId || tid === focusId) ? 0.7 : 0.05;
    });
  }

  const selectedNode = enrichedNodes.find((n) => n.id === selectedId) ?? null;

  const handleRailSelect = useCallback((id) => {
    setSelectedId(id);
    selectedIdRef.current = id;
    const node = nodesDataRef.current.find((n) => n.id === id);
    const svgEl = svgRef.current;
    // Re-apply highlight for rail-driven selection
    if (svgEl) {
      const svg = select(svgEl);
      const nodeGroup = svg.selectAll('g.node-g');
      const linkSel   = svg.selectAll('g.links line');
      applyHighlight(nodeGroup, linkSel, nodesDataRef.current, edgesDataRef.current, id);
    }
    // Pan/zoom to center the selected node
    if (node && node.x != null && zoomRef.current && svgEl) {
      const w = svgEl.clientWidth;
      const h = svgEl.clientHeight;
      select(svgEl).transition().duration(400).call(
        zoomRef.current.transform,
        d3ZoomIdentity.translate(w / 2 - node.x, h / 2 - node.y)
      );
    }
  }, []);

  const handleClear = useCallback(() => {
    setSelectedId(null);
  }, []);

  return (
    <div className="graph-layout">
      {/* ── Left: canvas + toolbar ─────────────────────────────────────── */}
      <div className="graph-canvas-wrap">
        {/* Toolbar */}
        <div className="graph-toolbar">
          <select
            className="graph-select"
            value={selectedOrg}
            onChange={(e) => setSelectedOrg(e.target.value)}
            disabled={orgs.length === 0}
          >
            {orgs.length === 0
              ? <option value="">No orgs available</option>
              : orgs.map((o) => (
                <option key={o.alias} value={o.alias}>{o.alias}</option>
              ))
            }
          </select>

          {ALL_TYPES.map((t) => (
            <button
              key={t}
              className={`graph-chip${activeTypes.has(t) ? ' active' : ''}`}
              onClick={() => toggleType(t)}
              type="button"
            >
              <span className="graph-chip-dot" style={{ background: typeColor(t) }} />
              {TYPE_LABELS[t] ?? t}
            </button>
          ))}

          <input
            className="graph-seed-input"
            placeholder="Component name…"
            aria-label="component name"
            value={seedName}
            onChange={(e) => setSeedName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') addSeed(); }}
            disabled={!selectedOrg}
          />
          <select
            className="graph-select"
            value={seedType}
            onChange={(e) => setSeedType(e.target.value)}
            aria-label="seed type"
          >
            {SEED_TYPES.map((t) => (
              <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            style={{ padding: '4px 12px', fontSize: 12 }}
            onClick={addSeed}
            disabled={busy || !selectedOrg || !seedName.trim()}
            type="button"
          >
            {busy ? 'Working…' : 'Add seed'}
          </button>
          {notFound && <span className="graph-badge" role="status">{notFound}</span>}
          <button
            className={`graph-chip${showGaps ? ' active' : ''}`}
            onClick={toggleGaps}
            type="button"
            title="Show source-parsed references the Tooling API may miss"
          >
            Gaps
          </button>
        </div>

        {/* SVG area */}
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          <div style={{ position: 'absolute', inset: 0, display: showGaps ? 'none' : undefined }}>
            {busy && (
              <div className="graph-loading-overlay">
                <div className="spinner" style={{ width: 24, height: 24 }} />
              </div>
            )}
            {error && !busy && (
              <div className="graph-empty-hint">
                <span style={{ color: 'var(--status-error-fg, #f87171)' }}>{error}</span>
              </div>
            )}
            {(!graphData || !graphData.nodes.length) && !busy && !error && (
              <div className="graph-empty-hint">
                Pick an org, enter a component name and type, then click <b>Add seed</b> to start
                exploring. Click any node to expand its dependencies.
              </div>
            )}

            <svg
              ref={svgRef}
              className="graph-svg"
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
            />
          </div>

          {showGaps && (
            <div className="gaps-panel">
              {gapsBusy && <div className="graph-empty-hint">Parsing source…</div>}
              {!gapsBusy && !gaps && (
                <div className="graph-empty-hint">
                  Enter a component name and type, then toggle Gaps to see source-parsed references.
                </div>
              )}
              {!gapsBusy && gaps && gaps.length === 0 && (
                <div className="graph-empty-hint">No source-parsed references found for that component.</div>
              )}
              {!gapsBusy && gaps && gaps.length > 0 && (
                <table className="gaps-table">
                  <thead><tr><th>Kind</th><th>Target</th><th>Evidence</th><th>Status</th></tr></thead>
                  <tbody>
                    {gaps.map((g, i) => (
                      <tr key={i}>
                        <td>{g.ref.kind}</td>
                        <td><span className="gaps-target-type">{g.ref.toType}:</span>{g.ref.toName}</td>
                        <td className="gaps-evidence">{g.ref.evidence} <span className="gaps-line">@{g.ref.line}</span></td>
                        <td><span className={`gaps-status gaps-${g.status}`}>{g.status}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ── Right: detail rail ─────────────────────────────────────────── */}
      <DetailRail
        selected={selectedNode}
        nodes={enrichedNodes}
        onSelectNode={handleRailSelect}
        onClear={handleClear}
      />
    </div>
  );
}
