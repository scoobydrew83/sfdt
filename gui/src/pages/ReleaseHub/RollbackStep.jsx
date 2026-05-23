import { useState, useEffect } from 'react';
import { api, stream } from '../../api.js';
import StreamRunner from '../../components/StreamRunner.jsx';
import { IconCheck } from '../../Icons.jsx';

// ─── Rollback Step ───────────────────────────────────────────────────────────

export default function RollbackStep() {
  const [history, setHistory]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [streamKey, setStreamKey]     = useState(0);

  useEffect(() => {
    api.deployHistory()
      .then((d) => setHistory(d.history ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Rollback</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Roll back the org to a previous deployment.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
          Deployment History
        </div>
        {loading && <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
        {!loading && history.length === 0 && (
          <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>
            No deployment history found. Deployments made via the GUI will appear here.
          </div>
        )}
        {history.map((entry) => (
          <button
            key={`${entry.date}-${entry.manifest}`}
            onClick={() => { setSelectedEntry(entry); setStreamKey((k) => k + 1); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              width: '100%', padding: '10px 14px',
              background: selectedEntry === entry ? 'var(--bg-selected)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border-subtle)',
              borderLeft: selectedEntry === entry ? '3px solid var(--brand-500)' : '3px solid transparent',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: entry.exitCode === 0 ? '#22c55e' : '#ef4444',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-default)' }}>
                {entry.manifest ?? 'Unknown manifest'}
                {entry.dryRun && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--fg-subtle)' }}>dry-run</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                {entry.org ?? 'default org'} · {new Date(entry.date).toLocaleString()}
              </div>
            </div>
            {selectedEntry === entry && <IconCheck size={12} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />}
          </button>
        ))}
      </div>

      <StreamRunner
        key={streamKey}
        label="Rollback deployment"
        startLabel="Roll Back"
        streamFn={selectedEntry ? () => stream.deploy({
          manifest: selectedEntry.manifest,
          org: selectedEntry.org,
          dryRun: false,
          skipPreflight: false,
          notifySlack: false,
        }) : null}
      />

      {!selectedEntry && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
          Select a deployment from history above to enable rollback.
        </div>
      )}
    </div>
  );
}
