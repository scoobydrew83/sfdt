import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';

function CoverageCell({ pct }) {
  if (pct == null) return <span style={{ color: 'var(--fg-subtle)' }}>—</span>;
  const color = pct >= 75
    ? 'var(--status-identical-fg)'
    : pct >= 60
    ? 'var(--status-modified-fg)'
    : 'var(--status-conflict-fg)';
  return <span style={{ fontWeight: 600, color, fontFamily: 'var(--font-mono)' }}>{pct}%</span>;
}

export default function TestRuns() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.testRuns()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const runs       = data?.runs ?? [];
  const totalPass  = runs.reduce((s, r) => s + (r.passed ?? 0), 0);
  const totalFail  = runs.reduce((s, r) => s + (r.failed ?? 0), 0);
  const lastCov    = runs[0]?.coverage;
  const lastDate   = runs[0]?.date ? new Date(runs[0].date).toLocaleDateString() : '—';

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Test Runs</h1>
          <p className="page-subtitle">Apex test execution history</p>
        </div>
      </div>

      <CommandRunner command="test" label="Apex Test Run" onComplete={() => setRefreshKey((k) => k + 1)} />

      {runs.length > 0 && (
        <div className="stats-grid mb-6">
          <StatCard label="Total Passed"   value={totalPass}  accent="green" />
          <StatCard label="Total Failed"   value={totalFail}  accent={totalFail > 0 ? 'red' : 'green'} />
          <StatCard label="Last Coverage"  value={lastCov != null ? `${lastCov}%` : '—'} accent="brand" />
          <StatCard label="Last Run"       value={lastDate}   accent="violet" />
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-4">
          <span>Failed to load test results: {error}</span>
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          title="No test runs found"
          message="Run sfdt test to generate results that will appear here."
        />
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Run History</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {runs.length} run{runs.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Passed</th>
                  <th style={{ textAlign: 'right' }}>Failed</th>
                  <th style={{ textAlign: 'right' }}>Errors</th>
                  <th>Coverage</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => {
                  const ok = !r.failed && !r.errors;
                  return (
                    <tr key={i}>
                      <td className="td-mono">{r.date ? new Date(r.date).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right', color: 'var(--status-identical-fg)', fontWeight: 600 }}>{r.passed ?? 0}</td>
                      <td style={{ textAlign: 'right', color: r.failed ? 'var(--status-conflict-fg)' : 'var(--fg-muted)', fontWeight: r.failed ? 600 : 400 }}>{r.failed ?? 0}</td>
                      <td style={{ textAlign: 'right', color: r.errors ? 'var(--status-conflict-fg)' : 'var(--fg-muted)' }}>{r.errors ?? 0}</td>
                      <td><CoverageCell pct={r.coverage} /></td>
                      <td className="td-mono">{r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '—'}</td>
                      <td><StatusBadge status={ok ? 'pass' : 'fail'} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {data?.summary && (
        <div className="card mt-4">
          <div className="card-head"><div className="card-title">Summary</div></div>
          <div className="card-body" style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
            {data.summary}
          </div>
        </div>
      )}
    </div>
  );
}
