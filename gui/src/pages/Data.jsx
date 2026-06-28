import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

export default function DataPage() {
  const [sets, setSets]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    api.data()
      .then((result) => { setSets(result?.sets ?? []); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load data sets'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Data Sets</h1>
          <p className="page-subtitle">Configured seed data sets for sfdt data export/import</p>
        </div>
      </div>

      <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
        <StatCard label="Data Sets" value={sets ? sets.length : '—'} accent="brand" />
        <StatCard label="Status" value={error ? 'Error' : sets ? 'Loaded' : '—'} accent={error ? 'red' : 'green'} />
      </div>

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && (
        <EmptyState title="Could not load data sets" message={error} />
      )}

      {!loading && !error && sets?.length === 0 && (
        <EmptyState
          title="No data sets"
          message="Create a data set directory under your configured data dir, then run sfdt data export <set>."
        />
      )}

      {!loading && !error && sets?.length > 0 && (
        <div className="card">
          <div className="card-head"><div className="card-title">Available Data Sets</div></div>
          <table className="data-table">
            <thead>
              <tr><th>Set Name</th><th>Commands</th></tr>
            </thead>
            <tbody>
              {sets.map((s, i) => (
                <tr key={i}>
                  <td className="td-name">{s}</td>
                  <td className="td-mono" style={{ color: 'var(--fg-subtle)' }}>
                    sfdt data export {s} · import {s}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
