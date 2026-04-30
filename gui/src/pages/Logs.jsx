import { Fragment, useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

const TYPE_LABELS = {
  'preflight': 'Preflight',
  'test-run':  'Test Run',
  'drift':     'Drift',
  'quality':   'Quality',
};

const TYPES = ['all', 'preflight', 'test-run', 'drift', 'quality'];

function getStatus(log) {
  if (log.type === 'test-run') {
    const d = log.data ?? {};
    return (d.failed > 0 || log.exitCode !== 0) ? 'FAIL' : 'PASS';
  }
  return log.data?.status ?? (log.exitCode === 0 ? 'PASS' : 'FAIL');
}

function formatDuration(ms) {
  if (ms == null) return '—';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function LogDetail({ log }) {
  const { type, data } = log;

  if (type === 'preflight') {
    const checks = data?.checks ?? [];
    return (
      <table className="data-table">
        <thead><tr><th>Check</th><th>Status</th><th>Message</th></tr></thead>
        <tbody>
          {checks.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td><StatusBadge status={c.status} /></td>
              <td style={{ color: 'var(--fg-muted)' }}>{c.message ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (type === 'drift') {
    const components = data?.components ?? [];
    if (!components.length) {
      return <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>No drift detected.</p>;
    }
    return (
      <table className="data-table">
        <thead><tr><th>Component</th><th>Type</th><th>Drift</th></tr></thead>
        <tbody>
          {components.map((c, i) => (
            <tr key={i}>
              <td>{c.name}</td>
              <td style={{ color: 'var(--fg-muted)' }}>{c.type}</td>
              <td>{c.drift}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  if (type === 'test-run') {
    const d = data ?? {};
    const tests = d.tests ?? [];
    return (
      <div>
        <div className="stats-grid mb-4">
          <StatCard label="Passed"   value={d.passed ?? 0}  accent="green" />
          <StatCard label="Failed"   value={d.failed ?? 0}  accent={d.failed > 0 ? 'red' : 'green'} />
          <StatCard label="Coverage" value={d.coverage != null ? `${d.coverage.toFixed(1)}%` : '—'} accent="brand" />
        </div>
        {tests.length > 0 && (
          <table className="data-table">
            <thead><tr><th>Test</th><th>Status</th><th>Duration</th></tr></thead>
            <tbody>
              {tests.map((t, i) => (
                <tr key={i}>
                  <td className="td-mono">{t.name}</td>
                  <td><StatusBadge status={t.status === 'Pass' ? 'pass' : 'fail'} /></td>
                  <td>{formatDuration(t.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  if (type === 'quality') {
    const d = data ?? {};
    const summary = d.summary ?? {};
    const violations = d.violations ?? [];
    return (
      <div>
        <div className="stats-grid mb-4">
          {['critical', 'high', 'medium', 'low'].map((level) => (
            <StatCard key={level} label={level.charAt(0).toUpperCase() + level.slice(1)} value={summary[level] ?? 0} />
          ))}
        </div>
        {violations.length > 0 && (
          <table className="data-table">
            <thead><tr><th>File</th><th>Rule</th><th>Line</th><th>Severity</th></tr></thead>
            <tbody>
              {violations.map((v, i) => (
                <tr key={i}>
                  <td className="td-mono" style={{ fontSize: 'var(--fs-xs)' }}>{v.file}</td>
                  <td>{v.rule}</td>
                  <td>{v.line}</td>
                  <td>{v.severity}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }

  return (
    <pre style={{
      margin: 0,
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--fs-xs)',
      color: 'var(--fg-muted)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      background: 'var(--bg-subtle)',
      padding: 'var(--s-3)',
      borderRadius: 'var(--r-md)',
      maxHeight: 300,
      overflow: 'auto',
    }}>
      {JSON.stringify(data ?? {}, null, 2)}
    </pre>
  );
}

export default function LogsPage() {
  const [logs, setLogs]           = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [expandedIdx, setExpandedIdx] = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.logs()
      .then(({ logs: l }) => setLogs(l ?? []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const filtered = typeFilter === 'all' ? logs : logs.filter((l) => l.type === typeFilter);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Log History</h1>
          <p className="page-subtitle">Browse historical run logs across all command types.</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '1.25rem' }}>
        {TYPES.map((t) => (
          <button
            key={t}
            className={`badge${typeFilter === t ? ' badge-active' : ''}`}
            style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0 }}
            onClick={() => { setTypeFilter(t); setExpandedIdx(null); }}
          >
            {t === 'all' ? 'All' : TYPE_LABELS[t]}
          </button>
        ))}
      </div>

      {error && <div className="alert alert-error mb-4">{error}</div>}
      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && !error && filtered.length === 0 && (
        <EmptyState
          title="No logs found"
          message={typeFilter === 'all' ? 'Run a command to generate logs.' : `No ${TYPE_LABELS[typeFilter]} logs found.`}
        />
      )}

      {!loading && !error && filtered.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Run History</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {filtered.length} log{filtered.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th>Date</th>
                  <th>Org</th>
                  <th>Status</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((log, i) => {
                  const status = getStatus(log);
                  const isOpen = expandedIdx === i;
                  return (
                    <Fragment key={`${log.timestamp}-${log.type}`}>
                      <tr
                        style={{ cursor: 'pointer' }}
                        onClick={() => setExpandedIdx(isOpen ? null : i)}
                        title={isOpen ? 'Collapse' : 'Expand details'}
                      >
                        <td>
                          <span className="badge badge-neutral" style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>
                            {TYPE_LABELS[log.type] ?? log.type}
                          </span>
                        </td>
                        <td className="td-mono">{log.timestamp ? new Date(log.timestamp).toLocaleString() : '—'}</td>
                        <td style={{ color: 'var(--fg-muted)' }}>{log.org ?? '—'}</td>
                        <td><StatusBadge status={status} /></td>
                        <td className="td-mono">{formatDuration(log.durationMs)}</td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={5} style={{ padding: '1rem 1.25rem', background: 'var(--surface-2, var(--bg-subtle))' }}>
                            <LogDetail log={log} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
