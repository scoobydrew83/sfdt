import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../api.js';
import CompareTable from '../components/CompareTable.jsx';
import DiffPanel from '../components/DiffPanel.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { IconArrowRight, IconX, IconCopy, IconDownload, IconCheck, IconSearch, IconPackage } from '../Icons.jsx';

const LOCAL_OPT = { id: 'local', label: 'Local Source', alias: 'local' };

export default function ComparePage() {
  const [orgs, setOrgs]                 = useState([]);
  const [source, setSource]             = useState(LOCAL_OPT);
  const [target, setTarget]             = useState(null);
  const [running, setRunning]           = useState(false);
  const [items, setItems]               = useState([]);
  const [hasResult, setHasResult]       = useState(false);
  const [phase2Active, setPhase2Active] = useState(false);
  const [phase2Done, setPhase2Done]     = useState(0);
  const [phase2Total, setPhase2Total]   = useState(0);
  const [streamError, setStreamError]   = useState(null);
  const [diffItem, setDiffItem]         = useState(null);
  const [selectedItems, setSelectedItems] = useState([]);
  const [manifestXml, setManifestXml]     = useState('');
  const [manifestOpen, setManifestOpen]   = useState(false);
  const [suggestedVersion, setSuggestedVersion] = useState('');
  const [version, setVersion]             = useState('');
  const [saving, setSaving]               = useState(false);
  const [saveSuccess, setSaveResult]      = useState(null);
  const esRef = useRef(null);

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => setOrgs(list ?? []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  // Bug 3: load cached compare results on mount
  useEffect(() => {
    api.compareResult()
      .then((data) => {
        if (data?.items?.length) {
          setItems(data.items);
          setHasResult(true);
          if (data.target) setTarget({ id: data.target, label: data.target });
        }
      })
      .catch(() => {});
  }, []);

  const allOrgs = useMemo(() => [LOCAL_OPT, ...orgs.map((o) => ({ id: o.alias, label: o.alias, alias: o.alias }))], [orgs]);

  const startPhase2 = () => {
    esRef.current?.close();
    setPhase2Active(true);
    setPhase2Done(0);

    const es = new EventSource('/api/compare/stream');
    esRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'progress') {
        setPhase2Total(event.total);
        setPhase2Done(event.completed);
      } else if (event.type === 'diff') {
        setItems((prev) => prev.map((i) =>
          i.type === event.itemType && i.member === event.member
            ? { ...i, status: event.status }
            : i,
        ));
      } else if (event.type === 'done') {
        setPhase2Active(false);
        es.close();
      }
    };
    es.onerror = () => {
      setStreamError('Streaming failed. The inventory was saved — click Run again to retry.');
      setPhase2Active(false);
      es.close();
    };
  };

  const handleRun = async () => {
    if (!target) return;
    setStreamError(null);
    setRunning(true);
    setItems([]);
    setHasResult(false);
    setPhase2Active(false);
    try {
      const result = await api.runCompare(source.id, target.id);
      setItems(result.items ?? []);
      setHasResult(true);
      if ((result.items ?? []).some((i) => i.status === 'both')) startPhase2();
    } catch (err) {
      console.error('Compare failed', err);
    } finally {
      setRunning(false);
    }
  };

  const handleBuildManifest = async (selected) => {
    setSelectedItems(selected);
    setSaveResult(null);
    try {
      const { xml } = await api.buildManifest(selected.map(({ type, member }) => ({ type, member })));
      setManifestXml(xml);
      setManifestOpen(true);
      
      // Fetch suggested version
      api.suggestVersion().then(d => {
        setSuggestedVersion(d.version);
        setVersion(d.version);
      }).catch(() => {});
    } catch (err) {
      console.error('Manifest build failed', err);
    }
  };

  const handleRemoveFromManifest = async (type, member) => {
    const next = selectedItems.filter(i => !(i.type === type && i.member === member));
    setSelectedItems(next);
    if (next.length === 0) {
      setManifestXml('');
      return;
    }
    const { xml } = await api.buildManifest(next.map(i => ({ type: i.type, member: i.member })));
    setManifestXml(xml);
  };

  const handleSaveManifest = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await api.buildManifest(selectedItems.map(({ type, member }) => ({ type, member })), {
        save: true,
        version: version || suggestedVersion
      });
      setSaveResult(res);
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };

  const phase2Pct = phase2Total > 0 ? Math.round((phase2Done / phase2Total) * 100) : 0;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Compare</h1>
          <p className="page-subtitle">Compare metadata between orgs or local source</p>
        </div>
      </div>

      {/* Org selector */}
      <div className="card mb-4">
        <div className="card-head">
          <div className="card-title">Configure comparison</div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <div className="input-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="input-label">Source</label>
              <select
                className="input"
                value={source.id}
                onChange={(e) => {
                  const opt = allOrgs.find((o) => o.id === e.target.value) ?? LOCAL_OPT;
                  setSource(opt);
                }}
              >
                {allOrgs.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </div>

            <div style={{ paddingBottom: 2, color: 'var(--fg-subtle)', flexShrink: 0 }}>
              <IconArrowRight size={16} />
            </div>

            <div className="input-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="input-label">Target org</label>
              <select
                className="input"
                value={target?.id ?? ''}
                onChange={(e) => {
                  const opt = orgs.find((o) => o.alias === e.target.value);
                  setTarget(opt ? { id: opt.alias, label: opt.alias } : null);
                }}
              >
                <option value="">Select target org…</option>
                {orgs.map((o) => (
                  <option key={o.alias} value={o.alias}>{o.alias}</option>
                ))}
              </select>
            </div>

            <button
              className="btn btn-primary"
              disabled={!source || !target || running}
              onClick={handleRun}
              style={{ flexShrink: 0 }}
            >
              {running ? 'Running…' : 'Run comparison'}
            </button>
          </div>
          <p style={{ marginTop: 'var(--s-2)', fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
            Use <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-muted)', padding: '1px 5px', borderRadius: 3 }}>local</code> for local source files, or any connected org alias.
          </p>
        </div>
      </div>

      {/* Phase 2 progress */}
      {phase2Active && (
        <div className="card mb-4">
          <div className="card-body" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)' }}>
            <div className="live-dot">comparing content</div>
            <div style={{ flex: 1 }}>
              <div className="progress">
                <div className="progress-fill" style={{ width: `${phase2Pct}%` }} />
              </div>
            </div>
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', flexShrink: 0 }}>
              {phase2Done} / {phase2Total}
            </span>
          </div>
        </div>
      )}

      {streamError && (
        <div className="alert alert-error mb-4">
          <span>{streamError}</span>
          <button className="alert-close" onClick={() => setStreamError(null)}>
            <IconX size={14} />
          </button>
        </div>
      )}

      {running && (
        <div className="spinner-center"><div className="spinner spinner-lg" /></div>
      )}

      {!running && !hasResult && !streamError && (
        <EmptyState
          title="No comparison yet"
          message="Select a source and target above, then click Run comparison."
        />
      )}

      {!running && hasResult && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Comparison results</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {source.label} → {target?.label}
            </div>
          </div>
          <div className="card-body">
            <CompareTable
              items={items}
              onSelect={setDiffItem}
              onBuildManifest={handleBuildManifest}
            />
          </div>
        </div>
      )}

      <DiffPanel item={diffItem} onClose={() => setDiffItem(null)} />

      {manifestOpen && (
        <div className="modal-backdrop" onClick={() => setManifestOpen(false)}>
          <div className="modal" style={{ maxWidth: 900, width: '95vw' }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">Build Release Manifest</span>
              <button className="btn btn-icon" onClick={() => setManifestOpen(false)}>
                <IconX size={15} />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, maxHeight: '65vh' }}>
              
              {/* Left Column: Component List */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="section-label" style={{ marginBottom: 10 }}>Components ({selectedItems.length})</div>
                <div className="table-wrap" style={{ flex: 1, overflowY: 'auto' }}>
                  <table className="data-table">
                    <tbody>
                      {selectedItems.map((i) => (
                        <tr key={`${i.type}.${i.member}`}>
                          <td>
                            <div style={{ fontSize: 12, fontWeight: 500 }}>{i.member}</div>
                            <div style={{ fontSize: 9, color: 'var(--fg-subtle)', textTransform: 'uppercase' }}>{i.type}</div>
                          </td>
                          <td style={{ width: 40, textAlign: 'right' }}>
                            <button className="btn btn-ghost btn-xs" style={{ color: 'var(--status-conflict-fg)' }} onClick={() => handleRemoveFromManifest(i.type, i.member)}>
                              <IconX size={12} />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Right Column: XML Preview & Save */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div className="section-label" style={{ marginBottom: 10 }}>XML Preview</div>
                <pre style={{
                  flex: 1,
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background: 'var(--bg-subtle)',
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--r-md)',
                  padding: 'var(--s-3)',
                  overflow: 'auto',
                  color: 'var(--fg-default)',
                  margin: 0,
                }}>
                  {manifestXml}
                </pre>
              </div>
            </div>

            <div className="modal-foot" style={{ justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="input-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <label style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>RELEASE VERSION</label>
                  <input
                    className="input"
                    style={{ width: 100, fontSize: 12, padding: '4px 8px' }}
                    value={version}
                    onChange={(e) => setVersion(e.target.value)}
                    placeholder={suggestedVersion}
                  />
                </div>
                {saveSuccess && (
                  <div style={{ fontSize: 11, color: 'var(--status-identical-fg)', display: 'flex', alignItems: 'center', gap: 4 }}>
                    <IconCheck size={14} /> Saved as {saveSuccess.filename}
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => navigator.clipboard.writeText(manifestXml ?? '')}
                >
                  <IconCopy size={12} /> Copy
                </button>
                <button className="btn btn-primary btn-sm" onClick={handleSaveManifest} disabled={saving || selectedItems.length === 0}>
                  {saving ? 'Saving...' : 'Save to Manifest Dir'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setManifestOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
