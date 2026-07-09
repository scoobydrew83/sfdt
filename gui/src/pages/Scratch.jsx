import { useState, useEffect, useCallback } from 'react';
import { api, stream } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { useCliRun, RunTerminal, useConfirm, ConfirmBar } from './Docs.jsx';

export default function ScratchPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.scratch()
      .then((result) => { setData(result); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load scratch pool'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const { run, start, running } = useCliRun(() => load());
  const { pending, request, confirm, cancel } = useConfirm();

  // In-app create form instead of window.prompt(): native dialogs are blocked
  // inside the VS Code dashboard's sandboxed iframe (see useConfirm in Docs.jsx).
  const [createOpen, setCreateOpen] = useState(false);
  const [alias, setAlias]           = useState('');

  const createOrg = () => {
    const trimmed = alias.trim();
    setCreateOpen(false);
    setAlias('');
    start(
      trimmed ? `sfdt scratch create --alias ${trimmed}` : 'sfdt scratch create',
      () => stream.commandRun('scratch-create', trimmed ? { alias: trimmed } : {}),
    );
  };

  const fillPool = () => {
    request(
      'Fill the scratch org pool? This creates the missing scratch orgs now.',
      () => start('sfdt scratch pool fill', () => stream.commandRun('scratch-pool-fill')),
      'Fill Pool',
    );
  };

  const deleteOrg = (target) => {
    if (!target) return;
    request(
      `Delete scratch org "${target}"? This is irreversible.`,
      () => start(`sfdt scratch delete ${target}`, () => stream.commandRun('scratch-delete', { target })),
      'Delete',
    );
  };

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
        <div className="page-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className="btn btn-primary btn-sm"
            disabled={running}
            onClick={() => setCreateOpen((open) => !open)}
          >
            Create Scratch Org
          </button>
        </div>
      </div>

      {createOpen && (
        <div className="card mb-4" role="form" aria-label="Create scratch org">
          <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <label className="input-label" htmlFor="scratch-alias" style={{ margin: 0 }}>
              Alias
            </label>
            <input
              id="scratch-alias"
              className="input"
              type="text"
              placeholder="Optional alias for the new scratch org"
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') createOrg(); }}
              style={{ flex: 1, minWidth: 200 }}
            />
            <div style={{ display: 'inline-flex', gap: 8 }}>
              <button className="btn btn-sm" onClick={() => { setCreateOpen(false); setAlias(''); }}>
                Cancel
              </button>
              <button className="btn btn-primary btn-sm" disabled={running} onClick={createOrg}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmBar pending={pending} onConfirm={confirm} onCancel={cancel} />

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

      {run.status !== 'idle' && (
        <div className="card mb-4">
          <RunTerminal run={run} />
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && (
        <EmptyState title="Could not load scratch data" message={error} />
      )}

      {!loading && !error && (
        <>
          <div className="card mb-6">
            <div className="card-head">
              <div className="card-title">Pool Members</div>
              <button className="btn btn-sm" disabled={running} onClick={fillPool}>
                Fill Pool
              </button>
            </div>
            {members.length === 0 ? (
              <EmptyState
                title="Pool is empty"
                message="Run sfdt scratch pool fill (or click Fill Pool above) to pre-create scratch orgs for faster provisioning."
              />
            ) : (
              <table className="data-table">
                <thead>
                  <tr><th>Alias</th><th>Org Id</th><th>Created</th><th></th></tr>
                </thead>
                <tbody>
                  {members.map((m, i) => (
                    <tr key={i}>
                      <td className="td-name">{m.alias ?? '—'}</td>
                      <td className="td-mono">{m.orgId ?? '—'}</td>
                      <td>{m.createdAt ? new Date(m.createdAt).toLocaleString() : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        {m.alias && (
                          <button className="btn btn-ghost btn-sm" disabled={running} onClick={() => deleteOrg(m.alias)}>
                            Delete
                          </button>
                        )}
                      </td>
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
                  <tr><th>Alias</th><th>Username</th><th>Expires</th><th>Status</th><th></th></tr>
                </thead>
                <tbody>
                  {orgs.map((o, i) => (
                    <tr key={i}>
                      <td className="td-name">{o.alias ?? '—'}</td>
                      <td className="td-mono">{o.username ?? '—'}</td>
                      <td>{o.expirationDate ?? '—'}</td>
                      <td><StatusBadge status={o.status ?? 'unknown'} /></td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={running}
                          onClick={() => deleteOrg(o.alias ?? o.username)}
                        >
                          Delete
                        </button>
                      </td>
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
