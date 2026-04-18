import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';
import { IconCheckCircle, IconXCircle, IconAlertTri, IconInfo } from '../Icons.jsx';

function CheckIcon({ status }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'success')
    return <IconCheckCircle size={14} style={{ color: 'var(--status-identical-fg)', flexShrink: 0 }} />;
  if (s === 'fail' || s === 'failed' || s === 'error')
    return <IconXCircle size={14} style={{ color: 'var(--status-conflict-fg)', flexShrink: 0 }} />;
  if (s === 'warn' || s === 'warning')
    return <IconAlertTri size={14} style={{ color: 'var(--status-modified-fg)', flexShrink: 0 }} />;
  return <IconInfo size={14} style={{ color: 'var(--fg-muted)', flexShrink: 0 }} />;
}

export default function PreflightPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    api.preflight()
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const checks      = data?.checks ?? [];
  const passCount   = checks.filter((c) => ['pass','passed','success'].includes(c.status?.toLowerCase())).length;
  const failCount   = checks.filter((c) => ['fail','failed','error'].includes(c.status?.toLowerCase())).length;
  const warnCount   = checks.filter((c) => ['warn','warning'].includes(c.status?.toLowerCase())).length;
  const overallStatus = data?.status;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Preflight</h1>
          <p className="page-subtitle">
            {data?.date ? `Last run ${new Date(data.date).toLocaleString()}` : 'Pre-deployment readiness checks'}
          </p>
        </div>
        {overallStatus && (
          <div className="page-header-actions">
            <StatusBadge status={overallStatus} />
          </div>
        )}
      </div>

      <CommandRunner command="preflight" label="Preflight Check" onComplete={() => setRefreshKey((k) => k + 1)} />

      {checks.length > 0 && (
        <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <StatCard label="Passed" value={passCount} accent="green" />
          <StatCard label="Failed" value={failCount} accent={failCount > 0 ? 'red' : 'green'} />
          <StatCard label="Warnings" value={warnCount} accent={warnCount > 0 ? 'amber' : 'brand'} />
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && checks.length === 0 && (
        <EmptyState
          title="No preflight data"
          message="Run sfdt preflight to generate a report."
        />
      )}

      {!loading && checks.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">{checks.length} Check{checks.length !== 1 ? 's' : ''}</div>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Check</th>
                <th>Message</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {checks.map((c, i) => (
                <tr key={i}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <CheckIcon status={c.status} />
                      <span style={{ fontWeight: 500 }}>{c.name}</span>
                    </div>
                  </td>
                  <td style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>
                    {c.message || '—'}
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
