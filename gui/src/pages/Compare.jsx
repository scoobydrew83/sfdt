import { useState, useEffect, useRef, useMemo } from 'react';
import { api } from '../api.js';
import CompareTable from '../components/CompareTable.jsx';
import DiffPanel from '../components/DiffPanel.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { IconArrowRight, IconX, IconCopy, IconDownload } from '../Icons.jsx';

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
  const [manifest, setManifest]         = useState(null);
  const [manifestOpen, setManifestOpen] = useState(false);
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
    try {
      const { xml } = await api.buildManifest(selected.map(({ type, member }) => ({ type, member })));
      setManifest(xml);
      setManifestOpen(true);
    } catch (err) {
      console.error('Manifest build failed', err);
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
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span className="modal-title">package.xml manifest</span>
              <button className="btn btn-icon" onClick={() => setManifestOpen(false)}>
                <IconX size={15} />
              </button>
            </div>
            <div className="modal-body">
              <pre style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--fs-sm)',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                background: 'var(--bg-subtle)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-md)',
                padding: 'var(--s-4)',
                maxHeight: '55vh',
                overflow: 'auto',
                color: 'var(--fg-default)',
                margin: 0,
              }}>
                {manifest}
              </pre>
            </div>
            <div className="modal-foot">
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => navigator.clipboard.writeText(manifest ?? '')}
              >
                <IconCopy size={12} /> Copy
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  const blob = new Blob([manifest ?? ''], { type: 'application/xml' });
                  const url  = URL.createObjectURL(blob);
                  const a    = document.createElement('a');
                  a.href = url; a.download = 'compare-manifest.xml'; a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <IconDownload size={12} /> Download
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setManifestOpen(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
