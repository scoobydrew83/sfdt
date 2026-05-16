import { useState, useEffect } from 'react';
import { api } from '../../api.js';
import {
  IconPackage, IconCheck, IconDownload, IconZap, IconSearch, IconX,
} from '../../Icons.jsx';
export default function ManifestStep({ onSelect, selected, onMarkDone, deployMode, setDeployMode, selectedSourceDir, setSelectedSourceDir }) {
  const [manifests, setManifests] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [base, setBase]           = useState('main');
  const [head, setHead]           = useState('HEAD');
  const [building, setBuilding]   = useState(false);
  const [buildResult, setBuildResult] = useState(null);
  const [viewingXml, setViewingXml] = useState(null);
  const [packages, setPackages]   = useState([]);
  useEffect(() => {
    api.listManifests()
      .then((d) => setManifests(d.manifests ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
    api.getPackages()
      .then((d) => setPackages(d.packages ?? []))
      .catch(() => {});
  }, []);
  const buildFromGit = async () => {
    setBuilding(true);
    setBuildResult(null);
    try {
      const res = await api.buildManifestFromGit(base, head);
      setBuildResult(res);
      const d = await api.listManifests();
      setManifests(d.manifests ?? []);
    } catch (err) {
      setBuildResult({ error: err.message });
    } finally {
      setBuilding(false);
    }
  };
  const viewManifest = async (m) => {
    try {
      const { xml } = await api.getManifestContent(m.relPath);
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'application/xml');
      const types = Array.from(doc.querySelectorAll('types'));
      const components = [];
      types.forEach(t => {
        const name = t.querySelector('name')?.textContent;
        const members = Array.from(t.querySelectorAll('members')).map(m => m.textContent);
        members.forEach(member => { components.push({ type: name, member }); });
      });
      setViewingXml({ ...m, xml, components });
    } catch (err) {
      alert(`Could not load manifest: ${err.message}`);
    }
  };
  const removeComponent = async (type, member) => {
    if (!viewingXml) return;
    try {
      await api.removeManifestComponent(viewingXml.relPath, type, member);
      viewManifest(viewingXml);
    } catch (err) {
      alert(`Remove failed: ${err.message}`);
    }
  };
  const downloadXml = (xml, name) => {
    const blob = new Blob([xml], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Target</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 12 }}>
        Choose a package.xml to use for this release, or deploy a source directory directly.
      </p>
      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${deployMode === 'manifest' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDeployMode('manifest')}
        >📄 Manifest</button>
        <button
          className={`btn btn-sm ${deployMode === 'folder' ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setDeployMode('folder')}
        >📁 Source folder</button>
      </div>
      {deployMode === 'manifest' && (
        <div style={{ display: 'grid', gridTemplateColumns: viewingXml ? '1fr 380px' : '1fr', gap: 24, alignItems: 'start' }}>
          <div>
            {}
            <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
            Available Manifests
          </div>
          {loading && <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
          {!loading && manifests.length === 0 && (
            <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>
              No manifests found. Generate one from git or run a Compare first.
            </div>
          )}
          {manifests.map((m) => (
            <button
              key={m.relPath}
              onClick={() => onSelect(m)}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                width: '100%', padding: '9px 14px',
                background: selected?.relPath === m.relPath ? 'var(--brand-50)' : 'transparent',
                border: 'none',
                borderBottom: '1px solid var(--border-subtle)',
                cursor: 'pointer',
                textAlign: 'left',
                borderLeft: selected?.relPath === m.relPath ? '3px solid var(--brand-500)' : '3px solid transparent',
              }}
            >
              <IconPackage size={13} style={{ color: selected?.relPath === m.relPath ? 'var(--brand-500)' : 'var(--fg-muted)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-default)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {m.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                  {m.source} · {new Date(m.date).toLocaleDateString()}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); viewManifest(m); }}>
                  <IconSearch size={10} /> View
                </button>
                {selected?.relPath === m.relPath && (
                  <IconCheck size={12} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
                )}
              </div>
            </button>
          ))}
        </div>
        {}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
            Generate from Git Diff
          </div>
          <div style={{ padding: '12px 14px' }}>
            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Base</label>
                <input className="input" style={{ fontSize: 12 }} value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Head</label>
                <input className="input" style={{ fontSize: 12 }} value={head} onChange={(e) => setHead(e.target.value)} placeholder="HEAD" />
              </div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={buildFromGit} disabled={building}>
              {building ? <><div className="live-dot" style={{ marginRight: 4 }} />Generating…</> : <><IconZap size={11} /> Generate</>}
            </button>
            {buildResult?.error && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--status-conflict-fg)' }}>Error: {buildResult.error}</div>
            )}
            {buildResult && !buildResult.error && (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
                Generated <strong style={{ color: 'var(--fg-default)' }}>{buildResult.filename}</strong>
                {' '}({buildResult.addCount} components)
                <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => downloadXml(buildResult.xml, buildResult.filename)}>
                  <IconDownload size={11} /> Download
                </button>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            className="btn btn-primary"
            onClick={onMarkDone}
            disabled={deployMode === 'folder' ? !selectedSourceDir : !selected}
          >
            Continue with {selected ? selected.name : '…'} →
          </button>
        </div>
      </div>
          {}
          {viewingXml && (
            <div className="card" style={{ position: 'sticky', top: 20, overflow: 'hidden' }}>
              <div className="card-head" style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 12, fontWeight: 600 }}>{viewingXml.name}</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className="btn btn-ghost btn-xs" onClick={() => downloadXml(viewingXml.xml, viewingXml.name)}>
                    <IconDownload size={10} /> Download
                  </button>
                  <button className="btn btn-icon btn-xs" onClick={() => setViewingXml(null)}>
                    <IconX size={12} />
                  </button>
                </div>
              </div>
              <div style={{ padding: '10px 14px', maxHeight: 400, overflowY: 'auto' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', marginBottom: 8 }}>
                  Components ({viewingXml.components.length})
                </div>
                {viewingXml.components.map((c, i) => (
                  <div key={`${c.type}.${c.member}-${i}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: '1px solid var(--border-subtle)' }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 500 }}>{c.member}</div>
                      <div style={{ fontSize: 10, color: 'var(--fg-subtle)', textTransform: 'uppercase' }}>{c.type}</div>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ padding: '0 14px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', margin: '8px 0' }}>XML</div>
                <pre style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-md)', padding: 10, maxHeight: 200, overflowY: 'auto',
                  color: 'var(--fg-default)', margin: 0,
                }}>{viewingXml.xml}</pre>
              </div>
            </div>
          )}
      </div>
      )}
      {deployMode === 'folder' && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 12 }}>
            Deploy a source directory directly. Select a package directory to deploy.
          </p>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {packages.length === 0 ? (
              <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>Loading packages…</span>
            ) : (
              packages.map((p) => (
                <button
                  key={p.name}
                  className={`btn btn-sm ${selectedSourceDir === p.path ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setSelectedSourceDir(p.path)}
                >
                  <IconPackage size={11} /> {p.name}
                </button>
              ))
            )}
          </div>
          {selectedSourceDir && (
            <div style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)', marginBottom: 12 }}>
              Will deploy: {selectedSourceDir}
            </div>
          )}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              className="btn btn-primary"
              onClick={onMarkDone}
              disabled={deployMode === 'folder' ? !selectedSourceDir : !selected}
            >
              Continue with {selectedSourceDir || '…'} →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
