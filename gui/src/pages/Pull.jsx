import { useState, useEffect, useRef } from 'react';
import { IconX } from '../Icons.jsx';
import { api, stream } from '../api.js';

const MODE_CARDS = [
  { mode: 'delta',   icon: '⚡', label: 'Smart Delta',    desc: 'Only changed components' },
  { mode: 'preview', icon: '👁', label: 'Preview',        desc: 'See what would be pulled' },
  { mode: 'full',    icon: '⬇', label: 'Full Retrieve',   desc: 'Everything from org' },
];

function getModeLabel(mode, groups, selectedGroup) {
  if (mode === 'group') {
    if (selectedGroup) {
      const g = groups.find((g) => g.key === selectedGroup);
      return `Group: ${g?.description ?? selectedGroup}`;
    }
    return 'Group';
  }
  return MODE_CARDS.find((c) => c.mode === mode)?.label ?? mode;
}

export default function PullPage() {
  const [mode, setMode]                    = useState('delta');
  const [status, setStatus]               = useState('idle');
  const [lines, setLines]                 = useState([]);
  const [progress, setProgress]           = useState(null);
  const [result, setResult]               = useState(null);
  const [groups, setGroups]               = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);

  const esRef      = useRef(null);
  const logRef     = useRef(null);
  const counterRef = useRef(0);
  const deadRef    = useRef(false);

  useEffect(() => {
    api.pullGroups()
      .then((data) => {
        const list = Array.isArray(data?.groups) ? data.groups : [];
        if (list.length > 0) {
          setGroups(list);
          setSelectedGroup(list[0].key);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      deadRef.current = true;
      esRef.current?.close();
    };
  }, []);

  const run = () => {
    setStatus('running');
    setLines([]);
    setProgress(null);
    setResult(null);
    counterRef.current = 0;

    const opts = { mode };
    if (mode === 'group' && selectedGroup) opts.groupKey = selectedGroup;

    const es = stream.pull(opts);
    esRef.current = es;

    es.onmessage = (e) => {
      if (deadRef.current) return;
      const msg = e.data;

      if (msg.type === 'log') {
        setLines((prev) => [...prev, { id: counterRef.current++, text: msg.line }]);
      } else if (msg.type === 'progress') {
        setProgress({ retrieved: msg.retrieved, total: msg.total });
      } else if (msg.type === 'result') {
        setStatus(msg.exitCode === 0 ? 'done' : 'error');
        setResult({ retrieved: msg.retrieved, elapsed: msg.elapsed });
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      if (deadRef.current) return;
      setStatus('error');
      es.close();
      esRef.current = null;
    };
  };

  const cancel = () => {
    esRef.current?.close();
    esRef.current = null;
    setStatus('idle');
    setProgress(null);
    setResult(null);
  };

  const modeLabel  = getModeLabel(mode, groups, selectedGroup);
  const isIdle     = status === 'idle';

  const visibleCards = groups.length > 0
    ? [...MODE_CARDS, { mode: 'group', icon: '📦', label: 'Groups', desc: 'Custom metadata groups' }]
    : MODE_CARDS;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Pull</h1>
          <p className="page-subtitle">Pull latest metadata from your org to local source</p>
        </div>
      </div>

      {/* Mode cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${visibleCards.length}, 1fr)`,
        gap: 12,
        opacity: isIdle ? 1 : 0.5,
        pointerEvents: isIdle ? 'auto' : 'none',
      }}>
        {visibleCards.map((card) => {
          const selected = mode === card.mode;
          return (
            <div
              key={card.mode}
              role="button"
              tabIndex={isIdle ? 0 : -1}
              data-mode={card.mode}
              onClick={() => isIdle && setMode(card.mode)}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && isIdle && setMode(card.mode)}
              aria-pressed={selected}
              aria-disabled={!isIdle}
              className="card"
              style={{
                cursor: 'pointer',
                padding: '16px',
                borderColor: selected ? 'var(--brand-500)' : 'var(--border-subtle)',
                background: selected ? 'color-mix(in srgb, var(--brand-500) 12%, var(--bg-surface))' : 'var(--bg-surface)',
                userSelect: 'none',
              }}
            >
              <div style={{ fontSize: 22, marginBottom: 6 }}>{card.icon}</div>
              <div style={{
                fontSize: 13,
                fontWeight: 600,
                color: selected ? 'var(--fg-brand)' : 'var(--fg-default)',
                marginBottom: 2,
              }}>
                {card.label}
              </div>
              <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{card.desc}</div>
            </div>
          );
        })}
      </div>

      {/* Group select */}
      {mode === 'group' && groups.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <select
            className="input"
            value={selectedGroup ?? ''}
            onChange={(e) => setSelectedGroup(e.target.value)}
            disabled={!isIdle}
          >
            {groups.map((g) => (
              <option key={g.key} value={g.key}>{g.description}</option>
            ))}
          </select>
        </div>
      )}

      {/* Run button */}
      {isIdle && (
        <div style={{ marginTop: 16 }}>
          <button className="btn btn-primary" onClick={run}>
            ▶ Run {modeLabel}
          </button>
        </div>
      )}

      {/* Running state — progress card */}
      {status === 'running' && (
        <div className="card" style={{ marginTop: 16 }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: progress ? 8 : 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="live-dot">running</div>
              <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
                {progress ? 'Retrieving components…' : 'Running…'}
              </span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={cancel}>
              <IconX size={11} /> Cancel
            </button>
          </div>
          {progress && (
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
                <span style={{ color: 'var(--fg-muted)' }}>Components retrieved</span>
                <span style={{ color: 'var(--fg-brand)', fontWeight: 600 }}>
                  {progress.retrieved} / {progress.total}
                </span>
              </div>
              <div style={{ background: 'var(--bg-subtle)', borderRadius: 4, height: 5, overflow: 'hidden' }}>
                <div style={{
                  background: 'linear-gradient(90deg, var(--brand-500), var(--accent-500))',
                  width: `${progress.total > 0 ? Math.round((progress.retrieved / progress.total) * 100) : 0}%`,
                  height: '100%',
                  borderRadius: 4,
                  transition: 'width 0.3s ease',
                }} />
              </div>
            </div>
          )}
        </div>
      )}

      {/* Done / error summary banner */}
      {(status === 'done' || status === 'error') && (
        <div style={{
          marginTop: 16,
          ...(status === 'done'
            ? { background: 'var(--status-identical-bg)', border: '1px solid var(--status-identical-border)' }
            : { background: 'var(--status-conflict-bg)',  border: '1px solid var(--status-conflict-border)' }),
          borderRadius: 8,
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          <span style={{ fontSize: 13 }}>
            {status === 'done'
              ? `✔ ${modeLabel} complete${result?.retrieved ? ` · ${result.retrieved} components retrieved` : ''} · ${result?.elapsed ?? 0}s`
              : `✗ Pull failed · ${result?.elapsed ?? 0}s elapsed`}
          </span>
          <button className="btn btn-ghost btn-sm" onClick={cancel}>
            ↺ Run again
          </button>
        </div>
      )}

      {/* Log terminal */}
      {lines.length > 0 && (
        <div className="cmd-terminal" ref={logRef} style={{ marginTop: 16 }}>
          {lines.map(({ id, text }) => (
            <div key={id} className="cmd-line">{text || ' '}</div>
          ))}
        </div>
      )}
    </div>
  );
}
