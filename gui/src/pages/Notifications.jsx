import { useState, useEffect } from 'react';
import { api } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';

export default function NotificationsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    setLoading(true);
    api.notifications()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const channels = data?.channels ?? [];

  const sendTest = async () => {
    setTesting(true);
    setResults(null);
    setError(null);
    try {
      const r = await api.notificationsTest();
      setResults(r.results ?? []);
    } catch (e) {
      setError(e.message);
    } finally {
      setTesting(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Notifications</h1>
          <p className="page-subtitle">
            Channels that receive deploy events and audit/monitor snapshots. Secrets are never shown.
            {data ? ` · AI executive summary: ${data.summary ? 'on' : 'off'}` : ''}
          </p>
        </div>
      </div>

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && <EmptyState title="Could not load notifications" message={error} />}

      {!loading && !error && channels.length === 0 && (
        <EmptyState
          title="No channels configured"
          message='Add channels under notifications.channels in .sfdt/config.json and set notifications.enabled = true.'
        />
      )}

      {!loading && channels.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Configured Channels {data?.enabled ? '' : '(notifications disabled)'}</div>
            <button
              onClick={sendTest}
              disabled={testing}
              style={{
                fontSize: '12px', padding: '4px 10px', borderRadius: '6px',
                border: '1px solid var(--brand-300, #a5b4fc)', background: 'var(--brand-50, #eef2ff)',
                color: 'var(--brand-700, #4338ca)', cursor: 'pointer', marginLeft: '8px',
              }}
            >
              {testing ? 'Sending…' : 'Send test to all channels'}
            </button>
          </div>
          <table className="data-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Min severity</th>
                <th>Events</th>
                <th>Target</th>
                {results && <th>Test result</th>}
              </tr>
            </thead>
            <tbody>
              {channels.map((c, i) => {
                const res = results?.find((r) => r.channel === c.name);
                return (
                  <tr key={i}>
                    <td className="td-name">{c.name}</td>
                    <td className="td-mono">{c.type}</td>
                    <td className="td-mono">{c.severityThreshold}</td>
                    <td className="td-mono">{Array.isArray(c.events) ? c.events.join(', ') : 'all'}</td>
                    <td>{c.target ? '✓ resolved' : '✗ missing'}</td>
                    {results && <td>{res ? (res.ok ? '✓ sent' : `✗ ${res.error}`) : '—'}</td>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
