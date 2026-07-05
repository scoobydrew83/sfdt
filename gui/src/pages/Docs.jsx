import { useState, useEffect, useRef, useCallback } from 'react';
import { api, stream } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import EmptyState from '../components/EmptyState.jsx';

// ─── Shared run-from-dashboard plumbing ──────────────────────────────────────
// The snapshot/action pages (Audit, Monitor, Scratch, Data, Docs) all stream a
// server-side CLI run over SSE and show the output in a small terminal. The
// shared hook + components live HERE because this page has the lightest
// import graph of the five (no HealthChecks → App.jsx chain), which keeps the
// sibling pages' unit tests free of heavy transitive imports.

/**
 * Manage a single streaming CLI run at a time.
 *
 * @param {(exitCode: number) => void} [onDone] Called when a run finishes
 *   (any exit code) so the page can refresh its data.
 * @returns {{ run: {status: string, label: string|null, lines: string[], exitCode: number|null},
 *             start: (label: string, factory: () => object) => void,
 *             running: boolean }}
 */
export function useCliRun(onDone) {
  const [run, setRun] = useState({ status: 'idle', label: null, lines: [], exitCode: null });
  const esRef = useRef(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => () => esRef.current?.close(), []);

  const start = useCallback((label, factory) => {
    esRef.current?.close();
    setRun({ status: 'running', label, lines: [], exitCode: null });

    const es = factory();
    esRef.current = es;

    es.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'log') {
        setRun((prev) => ({ ...prev, lines: [...prev.lines, msg.line] }));
      } else if (msg.type === 'result') {
        es.close();
        esRef.current = null;
        setRun((prev) => ({ ...prev, status: msg.exitCode === 0 ? 'done' : 'error', exitCode: msg.exitCode }));
        doneRef.current?.(msg.exitCode);
      } else if (msg.type === 'error') {
        es.close();
        esRef.current = null;
        setRun((prev) => ({ ...prev, status: 'error', lines: [...prev.lines, msg.message ?? 'Stream error'] }));
      }
    };
    es.onerror = (err) => {
      esRef.current = null;
      setRun((prev) => ({ ...prev, status: 'error', lines: [...prev.lines, err?.message ?? 'Request failed'] }));
    };
  }, []);

  return { run, start, running: run.status === 'running' };
}

/** Streaming-output terminal + status badge for a useCliRun run. */
export function RunTerminal({ run }) {
  const logRef = useRef(null);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run.lines]);

  if (run.status === 'idle') return null;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px 0' }}>
        <span className="td-mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>{run.label}</span>
        {run.status === 'running' && <div className="live-dot">running</div>}
        {run.status === 'done' && <span className="badge badge-success"><span className="badge-dot" />Complete</span>}
        {run.status === 'error' && (
          <span className="badge badge-error">
            <span className="badge-dot" />
            {run.exitCode != null ? `Exit ${run.exitCode}` : 'Failed'}
          </span>
        )}
      </div>
      {run.lines.length > 0 && (
        <div className="cmd-terminal" ref={logRef}>
          {run.lines.map((text, i) => (
            <div key={i} className="cmd-line">{text || ' '}</div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * In-app confirmation for mutating actions. Native `window.confirm()` /
 * `window.prompt()` are unusable here: the VS Code extension embeds this
 * dashboard in an iframe sandboxed WITHOUT `allow-modals`
 * (vscode/src/dashboard.ts), where confirm() silently returns false and
 * prompt() returns null — the click would be a no-op with no feedback.
 *
 * Usage: `const { pending, request, confirm, cancel } = useConfirm();`
 * then `request(message, action, confirmLabel)` from a button handler and
 * render `<ConfirmBar pending={pending} onConfirm={confirm} onCancel={cancel} />`.
 */
export function useConfirm() {
  const [pending, setPending] = useState(null);
  const request = (message, action, confirmLabel) => setPending({ message, action, confirmLabel });
  const confirm = () => {
    const p = pending;
    setPending(null);
    p?.action?.();
  };
  const cancel = () => setPending(null);
  return { pending, request, confirm, cancel };
}

/** Inline confirmation strip rendered by useConfirm consumers. */
export function ConfirmBar({ pending, onConfirm, onCancel }) {
  if (!pending) return null;
  return (
    <div className="card mb-4" role="alertdialog" aria-label="Confirm action">
      <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ flex: 1, minWidth: 200, fontSize: 'var(--fs-sm)', color: 'var(--fg-default)' }}>
          {pending.message}
        </span>
        <div style={{ display: 'inline-flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary btn-sm" onClick={onConfirm}>
            {pending.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Run now" card shared by the Audit and Monitor pages: one button that
 * streams `sfdt audit all` / `sfdt monitor all` from the server and a
 * terminal showing its output.
 */
export function SnapshotRunCard({ title, commandLabel, startStream, onComplete }) {
  const { run, start, running } = useCliRun(onComplete);
  return (
    <div className="card mb-4">
      <div className="card-head">
        <div className="card-title">{title}</div>
        <button
          className="btn btn-primary btn-sm"
          disabled={running}
          onClick={() => start(commandLabel, startStream)}
        >
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>
      <RunTerminal run={run} />
    </div>
  );
}

// ─── Docs page ────────────────────────────────────────────────────────────────

export default function DocsPage() {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    setLoading(true);
    api.docs()
      .then((result) => { setData(result); setError(null); })
      .catch((err) => setError(err.message ?? 'Failed to load docs config'))
      .finally(() => setLoading(false));
  }, []);

  const { run, start, running } = useCliRun();
  const { pending, request, confirm, cancel } = useConfirm();

  const cfg = data?.config ?? {};

  const generateDocs = () => {
    request(
      `Generate the documentation site into "${cfg.outputDir ?? 'docs'}"? This overwrites previously generated pages.`,
      () => start('sfdt docs generate', () => stream.commandRun('docs-generate')),
      'Generate Docs',
    );
  };

  const onOff = (v) => (v ? 'On' : 'Off');

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Documentation</h1>
          <p className="page-subtitle">MkDocs site configuration for sfdt docs generate</p>
        </div>
      </div>

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && error && (
        <EmptyState title="Could not load docs config" message={error} />
      )}

      <ConfirmBar pending={pending} onConfirm={confirm} onCancel={cancel} />

      {!loading && !error && data && (
        <>
          <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <StatCard label="Output Dir" value={cfg.outputDir ?? 'docs'} accent="brand" />
            <StatCard label="Diagrams" value={onOff(cfg.diagrams)} accent={cfg.diagrams ? 'green' : 'neutral'} />
            <StatCard
              label="Role Guides"
              value={onOff(cfg.roleGuides)}
              accent={cfg.roleGuides ? 'green' : 'neutral'}
              sub={data.aiEnabled ? undefined : 'Requires AI'}
            />
            <StatCard label="AI Authoring" value={onOff(cfg.ai && data.aiEnabled)} accent={cfg.ai && data.aiEnabled ? 'violet' : 'neutral'} />
          </div>

          {cfg.roleGuides && cfg.roles?.length > 0 && (
            <div className="card mb-6">
              <div className="card-head"><div className="card-title">Role Guides</div></div>
              <div style={{ padding: '12px 16px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {cfg.roles.map((r) => (
                  <span key={r} className="td-mono" style={{
                    fontSize: 'var(--fs-xs)', padding: '3px 10px', borderRadius: 6,
                    background: 'var(--bg-subtle)', color: 'var(--fg-default)',
                  }}>{r}</span>
                ))}
              </div>
            </div>
          )}

          <div className="card">
            <div className="card-head">
              <div className="card-title">Generate Docs</div>
              <button className="btn btn-primary btn-sm" disabled={running} onClick={generateDocs}>
                {running ? 'Generating…' : 'Generate Docs'}
              </button>
            </div>
            <div style={{ padding: '12px 16px' }}>
              <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', marginBottom: 8 }}>
                {data.note}
              </p>
              <code style={{
                display: 'inline-block', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
                padding: '6px 10px', borderRadius: 6, background: 'var(--bg-subtle)', color: 'var(--fg-default)',
              }}>
                sfdt docs generate{cfg.roleGuides ? ' --roles' : ''}
              </code>
            </div>
            <RunTerminal run={run} />
          </div>
        </>
      )}
    </div>
  );
}
