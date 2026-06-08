import { useState, useEffect } from 'react';
import { api } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import StatCard from '../components/StatCard.jsx';
import { IconRocket, IconList, IconActivity, IconGraph } from '../Icons.jsx';

function formatRelativeTime(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 1) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export default function FlowsPage() {
  const [orgs, setOrgs] = useState([]);
  const [selectedOrg, setSelectedOrg] = useState('');
  const [activeTab, setActiveTab] = useState('scan'); // 'scan', 'conflicts', 'graph'
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);

  // Data states
  const [scanData, setScanData] = useState(null);
  const [conflictsData, setConflictsData] = useState(null);
  const [graphData, setGraphData] = useState(null);

  // Search/selection states
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFlow, setSelectedFlow] = useState('');

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setSelectedOrg(list[0].alias);
      })
      .catch(() => {});

    // Try to load cached data
    api.flowScan().then(setScanData).catch(() => {});
    api.flowConflicts().then(setConflictsData).catch(() => {});
    api.flowGraph().then(setGraphData).catch(() => {});
  }, []);

  const handleRunScan = async () => {
    if (!selectedOrg) return;
    setError(null);
    setRunning(true);
    try {
      if (activeTab === 'scan') {
        const data = await api.runFlowScan(selectedOrg);
        setScanData(data);
      } else if (activeTab === 'conflicts') {
        const data = await api.runFlowConflicts(selectedOrg);
        setConflictsData(data);
      } else if (activeTab === 'graph') {
        const data = await api.runFlowGraph(selectedOrg);
        setGraphData(data);
        if (data.nodes && Object.keys(data.nodes).length > 0) {
          setSelectedFlow(Object.keys(data.nodes)[0]);
        }
      }
    } catch (err) {
      setError(err.message ?? 'Operation failed');
    } finally {
      setRunning(false);
    }
  };

  const getScoreColor = (score) => {
    if (score >= 90) return 'var(--status-identical-fg)';
    if (score >= 70) return 'var(--status-changed-fg)';
    return 'var(--status-conflict-fg)';
  };

  const getScoreBg = (score) => {
    if (score >= 90) return 'var(--status-identical-bg)';
    if (score >= 70) return 'var(--status-changed-bg)';
    return 'var(--status-conflict-bg)';
  };

  // Pre-select a flow in graph if it is loaded
  useEffect(() => {
    if (graphData?.nodes && !selectedFlow) {
      const keys = Object.keys(graphData.nodes);
      if (keys.length > 0) setSelectedFlow(keys[0]);
    }
  }, [graphData, selectedFlow]);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Flow Intelligence</h1>
          <p className="page-subtitle">
            Evaluate quality scores, record-triggered overlaps, and call graphs.
          </p>
        </div>
      </div>

      {/* Control panel */}
      <div className="card mb-4">
        <div className="card-body" style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
          <div className="input-field" style={{ flex: 1, minWidth: 200, margin: 0 }}>
            <label className="input-label" style={{ marginBottom: 4 }}>Salesforce Organization</label>
            <select
              className="input"
              value={selectedOrg}
              onChange={(e) => setSelectedOrg(e.target.value)}
            >
              <option value="">Select org…</option>
              {orgs.map((o) => (
                <option key={o.alias} value={o.alias}>{o.alias}</option>
              ))}
            </select>
          </div>
          <button
            className="btn btn-primary"
            disabled={!selectedOrg || running}
            onClick={handleRunScan}
          >
            {running ? 'Running Analysis…' : 'Run Analysis'}
          </button>
        </div>
      </div>

      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      {/* Tabs selection */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 8 }}>
        <button
          className={`btn btn-sm ${activeTab === 'scan' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setActiveTab('scan')}
        >
          <IconActivity size={14} style={{ marginRight: 6 }} /> Quality Scores
        </button>
        <button
          className={`btn btn-sm ${activeTab === 'conflicts' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setActiveTab('conflicts')}
        >
          <IconList size={14} style={{ marginRight: 6 }} /> Trigger Conflicts
        </button>
        <button
          className={`btn btn-sm ${activeTab === 'graph' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setActiveTab('graph')}
        >
          <IconGraph size={14} style={{ marginRight: 6 }} /> Call Graph
        </button>
      </div>

      {running && (
        <div className="spinner-center"><div className="spinner spinner-lg" /></div>
      )}

      {!running && (
        <div>
          {/* TAB 1: QUALITY SCAN */}
          {activeTab === 'scan' && (
            <div>
              {!scanData ? (
                <EmptyState
                  title="No quality scan loaded"
                  message="Select an org and click Run Analysis to scan active Flows."
                />
              ) : (
                <div>
                  <div className="stats-grid mb-4" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <StatCard label="Total Flows Scan" value={scanData.totalFlows} accent="brand" />
                    <StatCard label="Average Score" value={`${scanData.averageScore ?? '—'} / 100`} accent="green" />
                    <StatCard label="Errors" value={scanData.totalErrors} accent="orange" />
                  </div>

                  <div className="card">
                    <div className="card-head" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div className="card-title">Flow Scoring Table</div>
                      <input
                        className="input"
                        style={{ width: 220, fontSize: 12, padding: '4px 8px' }}
                        placeholder="Filter by name..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Flow Label / API Name</th>
                            <th>Type</th>
                            <th>API Version</th>
                            <th>Overall Score</th>
                            <th>Rating</th>
                            <th>Issue Families</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scanData.reports
                            .filter(r => r.label.toLowerCase().includes(searchQuery.toLowerCase()) || r.developerName.toLowerCase().includes(searchQuery.toLowerCase()))
                            .map((report) => (
                              <tr key={report.flowDefinitionId}>
                                <td>
                                  <div style={{ fontWeight: 600 }}>{report.label}</div>
                                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{report.developerName}</div>
                                </td>
                                <td style={{ fontSize: 12 }}>{report.flowType}</td>
                                <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>v{report.apiVersion}</td>
                                <td>
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                                    <div style={{ width: 60, height: 6, background: 'var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                                      <div style={{ width: `${report.overallScore}%`, height: '100%', background: getScoreColor(report.overallScore) }} />
                                    </div>
                                    <span style={{ fontSize: 12, fontWeight: 'bold', color: getScoreColor(report.overallScore) }}>
                                      {report.overallScore}
                                    </span>
                                  </div>
                                </td>
                                <td>
                                  <span style={{
                                    fontSize: 10,
                                    fontWeight: 'bold',
                                    padding: '2px 6px',
                                    borderRadius: 10,
                                    color: getScoreColor(report.overallScore),
                                    background: getScoreBg(report.overallScore)
                                  }}>
                                    {report.rating}
                                  </span>
                                </td>
                                <td>
                                  {report.issueFamilies?.length > 0 ? (
                                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                      {report.issueFamilies.map(fam => (
                                        <span key={fam.category} style={{ fontSize: 10, background: 'var(--bg-subtle)', padding: '1px 6px', borderRadius: 4, color: 'var(--fg-muted)' }}>
                                          {fam.category}: {fam.findings.length}
                                        </span>
                                      ))}
                                    </div>
                                  ) : (
                                    <span style={{ fontSize: 11, color: 'var(--status-identical-fg)' }}>✓ clean</span>
                                  )}
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: TRIGGER CONFLICTS */}
          {activeTab === 'conflicts' && (
            <div>
              {!conflictsData ? (
                <EmptyState
                  title="No trigger conflict analysis"
                  message="Select an org and click Run Analysis to audit overlapping Record-Triggered Flows."
                />
              ) : (
                <div>
                  <div className="stats-grid mb-4" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                    <StatCard label="Conflict Groups" value={conflictsData.totalGroups} accent="orange" />
                    <StatCard label="Flows in Conflicts" value={conflictsData.totalFlowsInConflicts} accent="brand" />
                  </div>

                  {conflictsData.groups.length === 0 ? (
                    <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--status-identical-fg)' }}>
                      ✓ No record-triggered overlaps detected. All trigger events are isolated.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                      {conflictsData.groups.map((group, gIdx) => (
                        <div key={gIdx} className="card">
                          <div className="card-head" style={{ background: 'var(--bg-subtle)' }}>
                            <div className="card-title" style={{ fontSize: 14, fontWeight: 700 }}>
                              {group.objectApiName} &middot; {group.triggerTiming} &middot; {group.triggerEvent}
                            </div>
                          </div>
                          <div className="card-body" style={{ padding: 0 }}>
                            <table className="table" style={{ margin: 0 }}>
                              <thead>
                                <tr>
                                  <th style={{ width: '40%' }}>Flow Label</th>
                                  <th style={{ width: '30%' }}>Trigger Order</th>
                                  <th style={{ width: '30%' }}>Entry Criteria</th>
                                </tr>
                              </thead>
                              <tbody>
                                {group.flows.map((flow, fIdx) => {
                                  const hasTriggerOrder = flow.triggerOrder != null;
                                  return (
                                    <tr key={fIdx}>
                                      <td>
                                        <div style={{ fontWeight: 600 }}>{flow.label}</div>
                                        <div style={{ fontSize: 10, color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)' }}>{flow.flowId}</div>
                                      </td>
                                      <td>
                                        {hasTriggerOrder ? (
                                          <span style={{ color: 'var(--status-identical-fg)', fontWeight: 600 }}>
                                            {flow.triggerOrder}
                                          </span>
                                        ) : (
                                          <span style={{ color: 'var(--status-conflict-fg)', background: 'var(--status-conflict-bg)', padding: '2px 6px', borderRadius: 4, fontSize: 10, fontWeight: 'bold' }}>
                                            Missing Order Flag
                                          </span>
                                        )}
                                      </td>
                                      <td style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                                        {flow.entryCriteriaSummary ?? <span style={{ fontStyle: 'italic', color: 'var(--status-conflict-fg)' }}>no entry criteria</span>}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: CALL GRAPH & RELATIONSHIPS */}
          {activeTab === 'graph' && (
            <div>
              {!graphData ? (
                <EmptyState
                  title="No subflow dependency graph"
                  message="Select an org and click Run Analysis to analyze subflow nesting and dependencies."
                />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: 16 }}>
                  {/* Left: Searchable node selector */}
                  <div className="card" style={{ height: 600, display: 'flex', flexDirection: 'column' }}>
                    <div style={{ padding: 12, borderBottom: '1px solid var(--border-subtle)' }}>
                      <input
                        className="input"
                        style={{ width: '100%', fontSize: 12 }}
                        placeholder="Search flows..."
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                      />
                    </div>
                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {Object.keys(graphData.nodes)
                        .filter(id => id.toLowerCase().includes(searchQuery.toLowerCase()) || (graphData.nodes[id].label ?? '').toLowerCase().includes(searchQuery.toLowerCase()))
                        .map(id => {
                          const isSelected = selectedFlow === id;
                          const node = graphData.nodes[id];
                          return (
                            <button
                              key={id}
                              style={{
                                width: '100%',
                                textAlign: 'left',
                                padding: '10px 12px',
                                background: isSelected ? 'var(--brand-500)' : 'transparent',
                                color: isSelected ? '#white' : 'var(--fg-default)',
                                border: 'none',
                                cursor: 'pointer',
                                borderBottom: '1px solid var(--border-subtle)',
                              }}
                              onClick={() => setSelectedFlow(id)}
                            >
                              <div style={{ fontSize: 12, fontWeight: 600, color: isSelected ? 'white' : undefined }}>
                                {node.label ?? id}
                              </div>
                              <div style={{ fontSize: 10, color: isSelected ? 'rgba(255,255,255,0.7)' : 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
                                {id}
                              </div>
                              {node.inCycle && (
                                <span style={{
                                  fontSize: 8,
                                  background: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--status-conflict-bg)',
                                  color: isSelected ? 'white' : 'var(--status-conflict-fg)',
                                  padding: '1px 4px',
                                  borderRadius: 4,
                                  fontWeight: 'bold',
                                  marginTop: 4,
                                  display: 'inline-block'
                                }}>
                                  CYCLE DETECTED
                                </span>
                              )}
                            </button>
                          );
                        })}
                    </div>
                  </div>

                  {/* Right: Selected Flow Details & Call Chains */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                    {selectedFlow && graphData.nodes[selectedFlow] ? (
                      <>
                        {/* Node Meta Cards */}
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                          <div className="card" style={{ padding: 16 }}>
                            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textTransform: 'uppercase', fontWeight: 600 }}>
                              Max Call Nesting Depth
                            </div>
                            <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4, color: 'var(--brand-500)' }}>
                              {graphData.nodes[selectedFlow].maxDepth}
                            </div>
                            <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 4 }}>
                              Longest acyclic chain starting from this node.
                            </div>
                          </div>

                          <div className="card" style={{ padding: 16 }}>
                            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', textTransform: 'uppercase', fontWeight: 600 }}>
                              Dependency Warning
                            </div>
                            <div style={{ fontSize: 16, fontWeight: 700, marginTop: 12 }}>
                              {graphData.nodes[selectedFlow].inCycle ? (
                                <span style={{ color: 'var(--status-conflict-fg)' }}>🚨 Part of circular dependency cycle</span>
                              ) : (
                                <span style={{ color: 'var(--status-identical-fg)' }}>✓ No circular references</span>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Incoming/Outgoing Relations */}
                        <div className="card">
                          <div className="card-head">
                            <div className="card-title">Flow Call Relationships</div>
                          </div>
                          <div className="card-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                            {/* Callers (Incoming) */}
                            <div>
                              <h3 style={{ fontSize: 12, fontWeight: 700, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
                                Called By ({graphData.nodes[selectedFlow].incoming.length})
                              </h3>
                              {graphData.nodes[selectedFlow].incoming.length === 0 ? (
                                <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic', padding: 8 }}>
                                  This is a root-level Flow (not invoked by other flows).
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                                  {graphData.nodes[selectedFlow].incoming.map(caller => (
                                    <button
                                      key={caller}
                                      className="btn btn-ghost btn-sm"
                                      style={{ textAlign: 'left', width: '100%' }}
                                      onClick={() => setSelectedFlow(caller)}
                                    >
                                      &larr; {caller}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>

                            {/* Subflows (Outgoing) */}
                            <div>
                              <h3 style={{ fontSize: 12, fontWeight: 700, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 6 }}>
                                Calls Subflows ({graphData.nodes[selectedFlow].outgoing.length})
                              </h3>
                              {graphData.nodes[selectedFlow].outgoing.length === 0 ? (
                                <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic', padding: 8 }}>
                                  This flow has no subflows.
                                </div>
                              ) : (
                                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
                                  {graphData.nodes[selectedFlow].outgoing.map(edge => {
                                    const exists = graphData.nodes[edge.id];
                                    return (
                                      <button
                                        key={edge.id}
                                        className="btn btn-ghost btn-sm"
                                        disabled={edge.missing}
                                        style={{
                                          textAlign: 'left',
                                          width: '100%',
                                          color: edge.missing ? 'var(--status-conflict-fg)' : undefined
                                        }}
                                        onClick={() => { if (!edge.missing) setSelectedFlow(edge.id); }}
                                      >
                                        &rarr; {edge.id} {edge.missing && ' [MISSING DEFINITION]'}
                                      </button>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>

                        {/* Mermaid export */}
                        <div className="card">
                          <div className="card-head">
                            <div className="card-title">Mermaid Call Graph Flowchart</div>
                          </div>
                          <div className="card-body" style={{ padding: 12 }}>
                            <p style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8 }}>
                              Copy this chart text to paste in Mermaid Live Editor, Github, or draw.io:
                            </p>
                            <pre style={{
                              background: 'var(--bg-subtle)',
                              padding: 12,
                              borderRadius: 4,
                              fontSize: 10,
                              fontFamily: 'var(--font-mono)',
                              maxHeight: 200,
                              overflow: 'auto',
                              border: '1px solid var(--border-subtle)'
                            }}>
                              {graphData.mermaid}
                            </pre>
                            <button
                              className="btn btn-ghost btn-sm"
                              style={{ marginTop: 8 }}
                              onClick={() => {
                                navigator.clipboard.writeText(graphData.mermaid);
                              }}
                            >
                              Copy Graph Code
                            </button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)' }}>
                        Select a flow on the left to inspect its dependency relationships.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
