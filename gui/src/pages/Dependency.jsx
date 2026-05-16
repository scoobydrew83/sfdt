import { useState, useEffect, useRef, useCallback } from 'react';
import { api } from '../api.js';
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
const TYPE_COLORS = {
  ApexClass:     'var(--brand-500)',
  ApexTrigger:   'var(--status-modified-solid)',
  ApexComponent: 'var(--status-source-solid)',
  Flow:          'var(--status-identical-solid)',
};
const ALL_TYPES = ['ApexClass', 'ApexTrigger', 'ApexComponent', 'Flow'];
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
export default function Dependency() {
  const [orgs, setOrgs]               = useState([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [activeTypes, setActiveTypes] = useState(new Set(ALL_TYPES));
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [graphData, setGraphData]     = useState(null);
  const [nodeCount, setNodeCount]     = useState(0);
  const [selectedId, setSelectedId]   = useState(null);
  const [enrichedNodes, setEnrichedNodes] = useState([]);
  const svgRef       = useRef(null);
  const simRef       = useRef(null);
  const gRef         = useRef(null);
  const nodesDataRef = useRef([]);
  const edgesDataRef = useRef([]);
  const selectedIdRef = useRef(null);
  const zoomRef       = useRef(null);
  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setSelectedOrg(list[0].alias);
      })
      .catch(() => {});
  }, []);
  const toggleType = useCallback((t) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  }, []);
  useEffect(() => {
    if (!graphData) { setEnrichedNodes([]); return; }
    const { nodes, edges } = graphData;
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
  const loadGraph = useCallback(async () => {
    if (!selectedOrg) return;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    try {
      const types = Array.from(activeTypes).join(',');
      const data = await api.dependencies(selectedOrg, types);
      const nodes = data.nodes ?? [];
      const edges = data.edges ?? [];
      setGraphData({ nodes, edges });
      setNodeCount(nodes.length);
    } catch (err) {
      setError(err.message ?? 'Failed to load dependencies');
      setGraphData(null);
      setNodeCount(0);
    } finally {
      setLoading(false);
    }
  }, [selectedOrg, activeTypes]);
  useEffect(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    if (simRef.current) {
      simRef.current.stop();
      simRef.current = null;
    }
    select(svgEl).selectAll('*').remove();
    if (!graphData || !graphData.nodes.length) return;
    const { nodes: rawNodes, edges: rawEdges } = graphData;
    const nodes = rawNodes.map((n) => ({ ...n }));
    const edges = rawEdges.map((e) => ({ ...e }));
    nodesDataRef.current = nodes;
    edgesDataRef.current = edges;
    const width  = svgEl.clientWidth  || 800;
    const height = svgEl.clientHeight || 600;
    const svg = select(svgEl);
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
    const g = svg.append('g').attr('class', 'zoom-group');
    gRef.current = g;
    const zoomBehavior = d3Zoom()
      .scaleExtent([0.1, 8])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
      });
    zoomRef.current = zoomBehavior;
    svg.call(zoomBehavior);
    const linkSel = g.append('g').attr('class', 'links')
      .selectAll('line')
      .data(edges)
      .join('line')
      .attr('stroke', 'var(--fg-muted)')
      .attr('stroke-opacity', 0.2)
      .attr('stroke-width', 1)
      .attr('marker-end', 'url(#dep-arrow)');
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
      });
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
    nodeGroup.on('click', (event, d) => {
      event.stopPropagation();
      const next = selectedIdRef.current === d.id ? null : d.id;
      selectedIdRef.current = next;
      setSelectedId(next);
      applyHighlight(nodeGroup, linkSel, nodes, edges, next);
    });
    nodeGroup.on('dblclick', (event, d) => {
      event.stopPropagation();
      d.fx = null;
      d.fy = null;
    });
    svg.on('click', () => {
      selectedIdRef.current = null;
      setSelectedId(null);
      applyHighlight(nodeGroup, linkSel, nodes, edges, null);
    });
    const sim = forceSimulation(nodes)
      .force('link', forceLink(edges).id((d) => d.id).distance(60))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(width / 2, height / 2))
      .force('collide', forceCollide(14))
      .on('tick', () => {
        linkSel
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);
        nodeGroup.attr('transform', (d) => `translate(${d.x},${d.y})`);
      });
    simRef.current = sim;
    return () => {
      sim.stop();
      svg.on('click', null);
    };
  }, [graphData]);
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
    if (svgEl) {
      const svg = select(svgEl);
      const nodeGroup = svg.selectAll('g.node-g');
      const linkSel   = svg.selectAll('g.links line');
      applyHighlight(nodeGroup, linkSel, nodesDataRef.current, edgesDataRef.current, id);
    }
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
      {}
      <div className="graph-canvas-wrap">
        {}
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
              {t}
            </button>
          ))}
          <button
            className="btn btn-primary"
            style={{ marginLeft: 'auto', padding: '4px 12px', fontSize: 12 }}
            onClick={loadGraph}
            disabled={loading || !selectedOrg}
            type="button"
          >
            {loading ? 'Loading…' : 'Load Graph'}
          </button>
          {nodeCount > 0 && (
            <span className="graph-badge">{nodeCount} nodes</span>
          )}
        </div>
        {}
        <div style={{ position: 'relative', flex: 1, minHeight: 0 }}>
          {loading && (
            <div className="graph-loading-overlay">
              <div className="spinner" style={{ width: 24, height: 24 }} />
            </div>
          )}
          {error && !loading && (
            <div className="graph-empty-hint">
              <span style={{ color: 'var(--status-error-fg, #f87171)' }}>{error}</span>
            </div>
          )}
          {!graphData && !loading && !error && (
            <div className="graph-empty-hint">
              Select an org and click Load Graph
            </div>
          )}
          {graphData && graphData.nodes.length === 0 && !loading && (
            <div className="graph-empty-hint">
              No dependency data found for the selected org and types
            </div>
          )}
          <svg
            ref={svgRef}
            className="graph-svg"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}
          />
        </div>
      </div>
      {}
      <DetailRail
        selected={selectedNode}
        nodes={enrichedNodes}
        onSelectNode={handleRailSelect}
        onClear={handleClear}
      />
    </div>
  );
}
