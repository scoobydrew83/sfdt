import { useState, useEffect } from 'react';
import { api } from '../api.js';
import { IconX } from '../Icons.jsx';

export default function DiffPanel({ item, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab]         = useState('diff');

  useEffect(() => {
    if (!item) { setData(null); return; }
    setLoading(true);
    setTab('diff');
    api.compareDiff(item.type, item.member)
      .then(setData)
      .catch(() => setData({ sourceXml: '', targetXml: '' }))
      .finally(() => setLoading(false));
  }, [item?.type, item?.member]);

  if (!item) return null;

  return (
    <>
      <div className="diff-panel-backdrop" onClick={onClose} />
      <aside className="diff-panel">
        <div className="diff-panel-head">
          <div style={{ minWidth: 0 }}>
            <div className="diff-panel-title">{item.member}</div>
            <div className="diff-panel-sub">{item.type}</div>
          </div>
          <button className="btn btn-icon" onClick={onClose} aria-label="Close">
            <IconX size={15} />
          </button>
        </div>

        <div className="diff-tabs">
          {['diff', 'source', 'target'].map((t) => (
            <button
              key={t}
              className={`diff-tab${tab === t ? ' active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        <div className="diff-tab-body">
          {loading && (
            <div className="spinner-center"><div className="spinner" /></div>
          )}

          {!loading && data && tab === 'diff' && (
            <LineDiff source={data.sourceXml ?? ''} target={data.targetXml ?? ''} />
          )}
          {!loading && data && tab === 'source' && (
            <pre className="xml-view">{data.sourceXml || '(empty)'}</pre>
          )}
          {!loading && data && tab === 'target' && (
            <pre className="xml-view">{data.targetXml || '(empty)'}</pre>
          )}
        </div>
      </aside>
    </>
  );
}

function LineDiff({ source, target }) {
  const srcLines = source.split('\n');
  const tgtLines = target.split('\n');
  const len = Math.max(srcLines.length, tgtLines.length);
  const rows = [];

  for (let i = 0; i < len; i++) {
    const s = srcLines[i] ?? '';
    const t = tgtLines[i] ?? '';
    const n = String(i + 1);
    if (s !== t) {
      if (s) rows.push({ type: 'removed', left: n, right: '', sign: '-', code: s });
      if (t) rows.push({ type: 'added',   left: '',  right: n, sign: '+', code: t });
    } else {
      rows.push({ type: 'context', left: n, right: n, sign: ' ', code: s });
    }
  }

  if (rows.length === 0) {
    return <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>Files are identical.</p>;
  }

  return (
    <div className="diff-view">
      {rows.map((row, i) => (
        <div key={i} className={`diff-row${row.type !== 'context' ? ` ${row.type}` : ''}`}>
          <span className="diff-gutter">{row.left}</span>
          <span className="diff-gutter">{row.right}</span>
          <span className="diff-sign">{row.sign}</span>
          <span className="diff-code">{row.code || '\u00A0'}</span>
        </div>
      ))}
    </div>
  );
}
