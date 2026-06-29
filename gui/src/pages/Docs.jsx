import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

export default function DocsPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    api.docs()
      .then((result) => { setData(result); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load docs config'))
      .finally(() => setLoading(false));
  }, []);

  const cfg = data?.config ?? {};

  const onOff = (v) => (v ? 'On' : 'Off');

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Documentation</h1>
          <p className="page-subtitle">MkDocs site configuration for sfdt docs generate</p>
        </div>
      </div>

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && (
        <EmptyState title="Could not load docs config" message={error} />
      )}

      {!loading && !error && data && (
        <>
          <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <StatCard label="Output Dir" value={cfg.outputDir ?? 'docs'} accent="brand" />
            <StatCard label="Diagrams" value={onOff(cfg.diagrams)} accent={cfg.diagrams ? 'green' : 'neutral'} />
            <StatCard
              label="Role Guides"
              value={onOff(cfg.roleGuides)}
              accent={cfg.roleGuides ? 'green' : 'neutral'}
              sub={data.aiEnabled ? undefined : 'Requires AI'}
            />
            <StatCard label="AI Authoring" value={onOff(cfg.ai && data.aiEnabled)} accent={cfg.ai && data.aiEnabled ? 'violet' : 'neutral'} />
          </div>

          {cfg.roleGuides && cfg.roles?.length > 0 && (
            <div className="card mb-6">
              <div className="card-head"><div className="card-title">Role Guides</div></div>
              <div style={{ padding: '12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {cfg.roles.map((r) => (
                  <span key={r} className="td-mono" style={{
                    fontSize: 'var(--fs-xs)', padding: '3px 10px', borderRadius: 6,
                    background: 'var(--bg-subtle)', color: 'var(--fg-default)',
                  }}>{r}</span>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head"><div className="card-title">Generate Docs</div></div>
            <div style={{ padding: '12px 16px' }}>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', marginBottom: 8 }}>
                {data.note}
              </p>
              <code style={{
                display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
                padding: '6px 10px', borderRadius: 6, background: 'var(--bg-subtle)', color: 'var(--fg-default)',
              }}>
                sfdt docs generate{cfg.roleGuides ? ' --roles' : ''}
              </code>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
