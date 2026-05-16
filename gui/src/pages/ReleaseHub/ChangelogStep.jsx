import { useState, useEffect, useRef } from 'react';
import { api, stream } from '../../api.js';
import { IconZap } from '../../Icons.jsx';
export default function ChangelogStep({ aiAvailable, onMarkDone }) {
  const [content, setContent]         = useState('');
  const [loading, setLoading]         = useState(true);
  const [generating, setGenerating]   = useState(false);
  const [saving, setSaving]           = useState(false);
  const [genLines, setGenLines]       = useState([]);
  const [packages, setPackages]       = useState([]);
  const [selectedPkg, setSelectedPkg] = useState('');
  const [changelogFile, setChangelogFile] = useState('CHANGELOG.md');
  const counterRef = useRef(0);
  const streamRef  = useRef(null);
  const genLogRef  = useRef(null);
  useEffect(() => {
    api.getPackages().then((d) => setPackages(d.packages ?? [])).catch(() => {});
  }, []);
  useEffect(() => {
    setLoading(true);
    streamRef.current?.close();
    api.changelogContent(selectedPkg || undefined)
      .then((d) => { setContent(d.content ?? ''); setChangelogFile(d.file ?? 'CHANGELOG.md'); })
      .catch(() => {})
      .finally(() => setLoading(false));
    return () => streamRef.current?.close();
  }, [selectedPkg]);
  useEffect(() => {
    if (genLogRef.current) genLogRef.current.scrollTop = genLogRef.current.scrollHeight;
  }, [genLines]);
  const generate = () => {
    setGenerating(true);
    setGenLines([]);
    counterRef.current = 0;
    const s = stream.changelogGenerate(selectedPkg || undefined);
    streamRef.current = s;
    s.onmessage = ({ data: msg }) => {
      if (msg.type === 'log') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        if (msg.content) setContent(msg.content);
        setGenerating(false);
      } else if (msg.type === 'error') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: `Error: ${msg.message}` }]);
        setGenerating(false);
      }
    };
    s.onerror = () => setGenerating(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      await api.saveChangelog(content, selectedPkg || undefined);
      onMarkDone();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Changelog</h2>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Review and edit the [Unreleased] section of <code style={{ fontSize: 12 }}>{changelogFile}</code>
          </p>
        </div>
        {aiAvailable && (
          <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
            {generating ? <><div className="live-dot" style={{ marginRight: 4 }} />Generating…</> : <><IconZap size={11} /> Generate with AI</>}
          </button>
        )}
      </div>
      {packages.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <button
            className={`btn btn-sm ${!selectedPkg ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setSelectedPkg('')}
          >All packages</button>
          {packages.map((p) => (
            <button
              key={p.name}
              className={`btn btn-sm ${selectedPkg === p.name ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setSelectedPkg(p.name)}
            >{p.name}</button>
          ))}
        </div>
      )}
      {loading && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Loading {changelogFile}…</div>}
      {!loading && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            width: '100%',
            height: 260,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            padding: '10px 12px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            color: 'var(--fg-default)',
            resize: 'vertical',
            outline: 'none',
            marginBottom: 10,
          }}
          placeholder="### Added&#10;- ...&#10;### Fixed&#10;- ..."
          spellCheck={false}
        />
      )}
      {genLines.length > 0 && (
        <div className="cmd-terminal" ref={genLogRef} style={{ maxHeight: 120, marginBottom: 10 }}>
          {genLines.map(({ id, text }) => (
            <div key={id} className="cmd-line">{text || ' '}</div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onMarkDone}>
          Skip (Don't Save)
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save & Continue →'}
        </button>
      </div>
    </div>
  );
}
