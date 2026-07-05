import { useState, useEffect, useCallback } from 'react';
import { api, stream } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { useCliRun, RunTerminal, useConfirm, ConfirmBar } from './Docs.jsx';

export default function DataPage() {
  const [sets, setSets]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.data()
      .then((result) => { setSets(result?.sets ?? []); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load data sets'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const { run, start, running } = useCliRun(() => load());
  const { pending, request, confirm, cancel } = useConfirm();

  const exportSet = (set) => {
    request(
      `Export data set "${set}" from the org? This overwrites the local data files for the set.`,
      () => start(`sfdt data export ${set}`, () => stream.commandRun('data-export', { set })),
    );
  };

  const importSet = (set) => {
    request(
      `Import data set "${set}" into the org? This inserts records.`,
      () => start(`sfdt data import ${set}`, () => stream.commandRun('data-import', { set })),
      'Import',
    );
  };

  const deleteSet = (set) => {
    request(
      `Bulk-delete the org records targeted by data set "${set}"? This is irreversible.`,
      () => start(`sfdt data delete ${set}`, () => stream.commandRun('data-delete', { set })),
      'Delete',
    );
  };

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

      <ConfirmBar pending={pending} onConfirm={confirm} onCancel={cancel} />

      {run.status !== 'idle' && (
        <div className="card mb-4">
          <RunTerminal run={run} />
        </div>
      )}

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
              <tr><th>Set Name</th><th style={{ textAlign: 'right' }}>Actions</th></tr>
            </thead>
            <tbody>
              {sets.map((s, i) => (
                <tr key={i}>
                  <td className="td-name">{s}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 6 }}>
                      <button className="btn btn-sm" disabled={running} onClick={() => exportSet(s)} title={`Export "${s}" from the org to local files`}>
                        Export
                      </button>
                      <button className="btn btn-sm" disabled={running} onClick={() => importSet(s)} title={`Import "${s}" into the org`}>
                        Import
                      </button>
                      <button className="btn btn-ghost btn-sm" disabled={running} onClick={() => deleteSet(s)} title={`Delete the org records targeted by "${s}"`}>
                        Delete
                      </button>
                    </div>
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
