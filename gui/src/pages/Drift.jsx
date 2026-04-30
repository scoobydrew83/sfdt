import { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';
import { ChatContext } from '../App.jsx';

export default function DriftPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [filter, setFilter]         = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);
  const chat = useContext(ChatContext);

  useEffect(() => {
    setLoading(true);
    api.drift()
      .then((result) => {
        setData(result);
        if (result) {
          const allComponents = result.components ?? [];
          const drifted = allComponents.filter((c) => c.drift?.toLowerCase() === 'drift');
          chat?.setPageContext({
            page: 'Drift',
            data: {
              org: result.org ?? null,
              driftedCount: drifted.length,
              components: drifted.slice(0, 20).map((c) => c.name ?? ''),
            },
          });
        }
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [refreshKey, chat]);

  const components = data?.components ?? [];
  const driftCount = components.filter((c) => c.drift?.toLowerCase() === 'drift').length;
  const cleanCount = components.filter((c) => c.drift?.toLowerCase() === 'clean').length;

  const filtered = filter === 'all'
    ? components
    : components.filter((c) => c.drift?.toLowerCase() === filter);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Drift Detection</h1>
          <p className="page-subtitle">
            {data?.date
              ? `Last checked ${new Date(data.date).toLocaleString()}`
              : 'Compare local source against target org'}
          </p>
        </div>
      </div>

      <CommandRunner command="drift" label="Drift Check" onComplete={() => setRefreshKey((k) => k + 1)} />

      {components.length > 0 && (
        <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <StatCard label="Total Components" value={components.length} accent="brand" />
          <StatCard label="Clean"  value={cleanCount}  accent="green" />
          <StatCard label="Drifted" value={driftCount} accent={driftCount > 0 ? 'amber' : 'green'} />
        </div>
      )}

      {components.length > 0 && (
        <div className="filter-bar mb-4">
          {[
            { id: 'all',   label: `All (${components.length})` },
            { id: 'clean', label: `Clean (${cleanCount})` },
            { id: 'drift', label: `Drift (${driftCount})` },
          ].map((opt) => (
            <button
              key={opt.id}
              className={`filter-chip${filter === opt.id ? ' active' : ''}`}
              onClick={() => setFilter(opt.id)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && components.length === 0 && (
        <EmptyState
          title="No drift data"
          message="Run sfdt drift to compare your local source against the target org."
        />
      )}

      {!loading && components.length > 0 && filtered.length === 0 && (
        <EmptyState title="No matches" message="Try a different filter." />
      )}

      {!loading && filtered.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Component Comparison</div>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {filtered.length} of {components.length}
            </span>
            {driftCount > 0 && chat && (
              <button
                onClick={() => chat?.openChat('My org has drifted metadata. Can you help me decide which components to retrieve and what might have caused the drift?')}
                style={{
                  fontSize: '12px',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--brand-300, #a5b4fc)',
                  background: 'var(--brand-50, #eef2ff)',
                  color: 'var(--brand-700, #4338ca)',
                  cursor: 'pointer',
                  marginLeft: '8px',
                }}
              >
                ✦ Ask AI about this drift
              </button>
            )}
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Component</th>
                <th>Type</th>
                <th>Drift Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={i}>
                  <td className="td-name">{c.name ?? '—'}</td>
                  <td className="td-mono">{c.type ?? '—'}</td>
                  <td><StatusBadge status={c.drift ?? 'unknown'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
