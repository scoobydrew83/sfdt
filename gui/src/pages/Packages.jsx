import { useEffect, useState } from 'react';
import { api } from '../api.js';

/**
 * Installed package inventory, and the editor for `.sfdt/packages.json`.
 *
 * This page exists because Salesforce has no API for "is there a newer version
 * of this managed package?" — AppExchange has no public API, and
 * `SubscriberPackageVersion` is queryable only in a Dev Hub for packages you
 * own. The only durable answer is one a human records, so this is where they
 * record it.
 *
 * It writes a COMMITTED repo file rather than browser storage, which is the
 * whole point: the vendor URL, the version someone checked, and who owns the
 * relationship become code-reviewed and shared instead of living in one
 * person's browser and dying with the profile.
 */

const STATUS_LABEL = {
  'update-available': 'Update available',
  'ahead-of-record': 'Note is stale',
  current: 'Matches record',
  unknown: 'Not tracked',
};

const STATUS_CLASS = {
  'update-available': 'badge badge-warn',
  'ahead-of-record': 'badge badge-info',
  current: 'badge badge-ok',
  unknown: 'badge',
};

function NoteEditor({ row, onSaved }) {
  const [url, setUrl] = useState(row.note?.url ?? '');
  const [latestKnown, setLatest] = useState(row.note?.latestKnown ?? '');
  const [owner, setOwner] = useState(row.note?.owner ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api.savePackageNote(row.key, { url, latestKnown, owner });
      onSaved();
    } catch (err) {
      // Validation failures come back as 400 with a usable message — an
      // unparseable version, a non-http URL. Show it rather than a generic
      // failure, because the fix is in what they typed.
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <label>
          Vendor URL
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
        </label>
        <label>
          Latest known version
          <input value={latestKnown} onChange={(e) => setLatest(e.target.value)} placeholder="3.10.0" />
        </label>
        <label>
          Owner
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Platform team" />
        </label>
        <button type="button" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save to .sfdt/packages.json'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      <p className="muted">
        Saved to a committed repo file — commit it so the whole team sees it. Recording a version
        here is a note to yourselves, not an API check.
      </p>
    </div>
  );
}

export default function PackagesPage() {
  const [vm, setVm] = useState(null);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .installedPackages()
      .then((data) => !cancelled && setVm(data))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [seq]);

  if (error) return <div className="card error">Could not read installed packages: {error}</div>;
  if (!vm) return <div className="card">Loading…</div>;

  return (
    <div>
      <h1>Packages</h1>
      <p className="muted">
        Installed in <strong>{vm.org}</strong> — {vm.counts.total} package(s),{' '}
        {vm.counts.managed} managed, {vm.counts.unmanaged} unmanaged.
      </p>

      <table>
        <thead>
          <tr>
            <th scope="col">Package</th>
            <th scope="col">Namespace</th>
            <th scope="col">Installed</th>
            <th scope="col">Status</th>
            <th scope="col" />
          </tr>
        </thead>
        <tbody>
          {vm.rows.map((row) => (
            <tr key={row.key}>
              <td>
                {row.name}
                {expanded === row.key && <NoteEditor row={row} onSaved={() => setSeq((n) => n + 1)} />}
                {row.updateDetail && row.updateStatus !== 'unknown' && (
                  <div className="muted">{row.updateDetail}</div>
                )}
              </td>
              <td>{row.namespace ?? <span className="muted">unmanaged</span>}</td>
              <td>{row.versionText ?? <span className="muted">unknown</span>}</td>
              <td>
                <span className={STATUS_CLASS[row.updateStatus]}>{STATUS_LABEL[row.updateStatus]}</span>
              </td>
              <td>
                <button type="button" onClick={() => setExpanded(expanded === row.key ? null : row.key)}>
                  {expanded === row.key ? 'Close' : 'Notes'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {vm.notes.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>Notes</h2>
          <ul>
            {vm.notes.map((note) => (
              <li key={note} className="muted">
                {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
