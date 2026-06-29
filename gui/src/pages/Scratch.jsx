import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

export default function ScratchPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    api.scratch()
      .then((result) => { setData(result); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load scratch pool'))
      .finally(() => setLoading(false));
  }, []);

  const pool    = data?.pool ?? { size: 0, members: [] };
  const members = pool.members ?? [];
  const orgs    = data?.orgs ?? [];

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Scratch Orgs</h1>
          <p className="page-subtitle">Pre-created scratch org pool and active scratch orgs</p>
        </div>
      </div>

      <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <StatCard label="Pool Filled" value={data ? `${members.length}/${pool.size ?? 0}` : '—'} accent="brand" />
        <StatCard label="Active Scratch Orgs" value={data ? orgs.length : '—'} accent="violet" />
        <StatCard
          label="Pool Capacity"
          value={data ? (pool.size ?? 0) : '—'}
          sub={pool.size ? undefined : 'Set scratch.poolSize in config'}
          accent="neutral"
        />
      </div>

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && (
        <EmptyState title="Could not load scratch data" message={error} />
      )}

      {!loading && !error && (
        <>
          <div className="card mb-6">
            <div className="card-head"><div className="card-title">Pool Members</div></div>
            {members.length === 0 ? (
              <EmptyState
                title="Pool is empty"
                message="Run sfdt scratch pool fill to pre-create scratch orgs for faster provisioning."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr><th>Alias</th><th>Org Id</th><th>Created</th></tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={i}>
                      <td className="td-name">{m.alias ?? '—'}</td>
                      <td className="td-mono">{m.orgId ?? '—'}</td>
                      <td>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="card">
            <div className="card-head"><div className="card-title">Active Scratch Orgs</div></div>
            {orgs.length === 0 ? (
              <EmptyState title="No scratch orgs" message="No active scratch orgs found via sf org list." />
            ) : (
              <table className="data-table">
                <thead>
                  <tr><th>Alias</th><th>Username</th><th>Expires</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {orgs.map((o, i) => (
                    <tr key={i}>
                      <td className="td-name">{o.alias ?? '—'}</td>
                      <td className="td-mono">{o.username ?? '—'}</td>
                      <td>{o.expirationDate ?? '—'}</td>
                      <td><StatusBadge status={o.status ?? 'unknown'} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
