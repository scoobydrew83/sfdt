import { useState, useEffect } from 'react';
import { api } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import { IconX, IconCopy, IconDownload, IconFileText, IconPackage } from '../Icons.jsx';

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function ManifestViewer({ xml, onClose }) {
  if (!xml) return null;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 700, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">package.xml</span>
          <button className="btn btn-icon" onClick={onClose}><IconX size={15} /></button>
        </div>
        <div className="modal-body">
          <pre style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', whiteSpace: 'pre-wrap',
            wordBreak: 'break-all', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--r-md)', padding: 'var(--s-4)', maxHeight: '55vh', overflow: 'auto',
            color: 'var(--fg-default)', margin: 0,
          }}>{xml}</pre>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(xml)}>
            <IconCopy size={12} /> Copy
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => {
            const blob = new Blob([xml], { type: 'application/xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'manifest.xml'; a.click();
            URL.revokeObjectURL(url);
          }}>
            <IconDownload size={12} /> Download
          </button>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function BuilderSection({ aiInfo, onBuilt }) {
  const [base, setBase] = useState('main');
  const [head, setHead] = useState('HEAD');
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  const handleBuild = async () => {
    setBuilding(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.buildManifestFromGit(base, head);
      setResult(r);
      onBuilt?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBuilding(false);
    }
  };

  return (
    <div className="card mb-4">
      <div className="card-head">
        <div className="card-title">Build manifest from git diff</div>
        {aiInfo?.enabled && (
          <span className="badge badge-info" style={{ fontSize: 'var(--fs-xs)' }}>
            AI available — use CLI for AI cleanup
          </span>
        )}
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
          <div className="input-field" style={{ flex: 1, minWidth: 140 }}>
            <label className="input-label">Base ref</label>
            <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" />
          </div>
          <div className="input-field" style={{ flex: 1, minWidth: 140 }}>
            <label className="input-label">Head ref</label>
            <input className="input" value={head} onChange={(e) => setHead(e.target.value)} placeholder="HEAD" />
          </div>
          <button className="btn btn-primary" disabled={building || !base || !head} onClick={handleBuild} style={{ flexShrink: 0 }}>
            {building ? 'Generating…' : 'Generate manifest'}
          </button>
        </div>
        <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
          Generates a package.xml from changed metadata files between the two git refs.
          {aiInfo?.enabled && ' For AI dependency cleanup, run <code>sfdt manifest --ai-cleanup</code> in your terminal.'}
        </p>

        {error && (
          <div className="alert alert-error mt-3">
            <span>{error}</span>
          </div>
        )}

        {result && (
          <div className="mt-3" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
            <span className="badge badge-success">Generated</span>
            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {result.addCount} additive · {result.delCount} destructive
            </span>
            <button className="btn btn-secondary btn-sm" onClick={() => setViewerOpen(true)}>
              <IconFileText size={12} /> View XML
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => {
              const blob = new Blob([result.xml], { type: 'application/xml' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url; a.download = result.filename ?? 'manifest.xml'; a.click();
              URL.revokeObjectURL(url);
            }}>
              <IconDownload size={12} /> Download
            </button>
          </div>
        )}
      </div>
      {viewerOpen && result && <ManifestViewer xml={result.xml} onClose={() => setViewerOpen(false)} />}
    </div>
  );
}

export default function ManifestsPage() {
  const [manifests, setManifests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiInfo, setAiInfo] = useState(null);
  const [viewerXml, setViewerXml] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    api.aiAvailable().then(setAiInfo).catch(() => null);
  }, []);

  useEffect(() => {
    setLoading(true);
    api.listManifests()
      .then(({ manifests: list }) => setManifests(list ?? []))
      .catch(() => setManifests([]))
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const handleView = async (m) => {
    try {
      const { xml } = await api.getManifestContent(m.relPath);
      setViewerXml(xml);
    } catch (err) {
      console.error('Failed to load manifest', err);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Manifests</h1>
          <p className="page-subtitle">Build and manage deployment package.xml manifests</p>
        </div>
      </div>

      <BuilderSection aiInfo={aiInfo} onBuilt={() => setRefreshKey((k) => k + 1)} />

      <div className="card">
        <div className="card-head">
          <div className="card-title">Manifest history</div>
          <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
            {manifests.length} file{manifests.length !== 1 ? 's' : ''}
          </span>
        </div>

        {loading && <div className="spinner-center"><div className="spinner" /></div>}

        {!loading && manifests.length === 0 && (
          <EmptyState
            title="No manifests yet"
            message="Build a manifest above or run sfdt manifest / sfdt compare in your terminal."
          />
        )}

        {!loading && manifests.length > 0 && (
          <table className="data-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Source</th>
                <th>Date</th>
                <th>Size</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {manifests.map((m) => (
                <tr key={m.relPath}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <IconPackage size={13} style={{ color: 'var(--fg-brand)', flexShrink: 0 }} />
                      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{m.name}</span>
                    </div>
                  </td>
                  <td>
                    <span className={`badge ${m.source === 'compare' ? 'badge-info' : 'badge-neutral'}`} style={{ fontSize: 10 }}>
                      {m.source}
                    </span>
                  </td>
                  <td style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-xs)' }}>{fmtDate(m.date)}</td>
                  <td style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' }}>{fmtSize(m.size)}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => handleView(m)}>
                      View
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewerXml && <ManifestViewer xml={viewerXml} onClose={() => setViewerXml(null)} />}
    </div>
  );
}
