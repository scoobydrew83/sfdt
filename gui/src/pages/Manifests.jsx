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

function ManifestViewer({ manifest, preloadedXml, onClose }) {
  const [data, setData] = useState(null); // { xml, components: [] }
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const xml = preloadedXml ?? (await api.getManifestContent(manifest.relPath)).xml;
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'application/xml');
      const types = Array.from(doc.querySelectorAll('types'));
      const components = [];
      types.forEach(t => {
        const name = t.querySelector('name')?.textContent;
        const members = Array.from(t.querySelectorAll('members')).map(m => m.textContent);
        members.forEach(member => { components.push({ type: name, member }); });
      });
      setData({ xml, components });
    } catch (err) {
      alert(`Load failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [manifest, preloadedXml]);

  const removeComponent = async (type, member) => {
    try {
      await api.removeManifestComponent(manifest.relPath, type, member);
      load();
    } catch (err) {
      alert(`Remove failed: ${err.message}`);
    }
  };

  if (!manifest && !preloadedXml) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 900, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ minWidth: 0 }}>
            <span className="modal-title" style={{ display: 'block' }}>{manifest.name}</span>
            <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{manifest.relPath}</span>
          </div>
          <button className="btn btn-icon" onClick={onClose}><IconX size={15} /></button>
        </div>
        <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, maxHeight: '65vh' }}>
          
          {loading ? (
            <div style={{ gridColumn: 'span 2', padding: 40, textAlign: 'center' }}><div className="spinner" /></div>
          ) : (
            <>
              {/* Left Column: Component List */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="section-label" style={{ marginBottom: 10 }}>Components ({data?.components?.length ?? 0})</div>
                <div className="table-wrap" style={{ flex: 1, overflowY: 'auto' }}>
                  <table className="data-table">
                    <tbody>
                      {data?.components?.map((c, i) => (
                        <tr key={`${c.type}.${c.member}-${i}`}>
                          <td>
                            <div style={{ fontSize: 12, fontWeight: 500 }}>{c.member}</div>
                            <div style={{ fontSize: 9, color: 'var(--fg-subtle)', textTransform: 'uppercase' }}>{c.type}</div>
                          </td>
                          <td style={{ width: 40, textAlign: 'right' }}>
                            {manifest?.relPath && manifest.source !== 'deployed' && (
                              <button className="btn btn-ghost btn-xs" style={{ color: 'var(--status-conflict-fg)' }} onClick={() => removeComponent(c.type, c.member)}>
                                <IconX size={12} />
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Column: XML Preview */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="section-label" style={{ marginBottom: 10 }}>XML Preview</div>
                <pre style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-md)', padding: 'var(--s-3)', overflow: 'auto',
                  color: 'var(--fg-default)', margin: 0,
                }}>{data?.xml}</pre>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(data?.xml ?? '')}>
            <IconCopy size={12} /> Copy
          </button>
          <button className="btn btn-primary btn-sm" onClick={() => {
            const blob = new Blob([data?.xml ?? ''], { type: 'application/xml' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = manifest?.name ?? 'manifest.xml'; a.click();
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
  const [version, setVersion] = useState('');
  const [suggestedVersion, setSuggestedVersion] = useState('');
  const [building, setBuilding] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    api.suggestVersion().then(d => {
      setSuggestedVersion(d.version);
      setVersion(d.version);
    }).catch(() => {});
  }, []);

  const handleBuild = async () => {
    setBuilding(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.buildManifestFromGit(base, head, {
        save: true,
        version: version || suggestedVersion
      });
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
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap', marginBottom: 12 }}>
          <div className="input-field" style={{ flex: 1, minWidth: 120 }}>
            <label className="input-label">Base ref</label>
            <input className="input" value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" />
          </div>
          <div className="input-field" style={{ flex: 1, minWidth: 120 }}>
            <label className="input-label">Head ref</label>
            <input className="input" value={head} onChange={(e) => setHead(e.target.value)} placeholder="HEAD" />
          </div>
          <div className="input-field" style={{ flex: 1, minWidth: 100 }}>
            <label className="input-label">Release Version</label>
            <input className="input" value={version} onChange={(e) => setVersion(e.target.value)} placeholder={suggestedVersion} />
          </div>
          <button className="btn btn-primary" disabled={building || !base || !head} onClick={handleBuild} style={{ flexShrink: 0 }}>
            {building ? 'Generating…' : 'Generate & Save'}
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
      {viewerOpen && result && (
        <ManifestViewer
          manifest={{ relPath: null, name: result.filename ?? 'manifest.xml', source: 'preview' }}
          preloadedXml={result.xml}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

export default function ManifestsPage() {
  const [manifests, setManifests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [aiInfo, setAiInfo] = useState(null);
  const [selectedManifest, setSelectedManifest] = useState(null);
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
                    <span className={`badge ${m.source === 'compare' ? 'badge-info' : m.source === 'deployed' ? 'badge-success' : 'badge-neutral'}`} style={{ fontSize: 10 }}>
                      {m.source === 'deployed' ? 'released' : m.source}
                    </span>
                  </td>
                  <td style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-xs)' }}>{fmtDate(m.date)}</td>
                  <td style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)' }}>{fmtSize(m.size)}</td>
                  <td>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelectedManifest(m)}>
                      {m.source === 'deployed' ? 'View' : 'Edit'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {selectedManifest && <ManifestViewer manifest={selectedManifest} onClose={() => { setSelectedManifest(null); setRefreshKey(k => k + 1); }} />}
    </div>
  );
}
