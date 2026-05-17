import { useState, useRef, useEffect, useContext, useMemo } from 'react';
import { IconPlay, IconX, IconRefresh, IconTerminal } from '../Icons.jsx';
import { ChatContext } from '../App.jsx';
import { extractErrorLines } from './CommandRunner.jsx';

/**
 * Like CommandRunner but drives a POST-based SSE stream from api.stream.*.
 * Props:
 *   label        — title text
 *   startLabel   — button label (default "Run")
 *   streamFn     — () => stream object from api.stream.*
 *   onComplete   — called when exitCode === 0
 *   children     — optional content rendered above the terminal (form inputs, etc.)
 *   commandHint  — short string used in the Ask-AI prompt to identify what ran
 */
export default function StreamRunner({ label, startLabel = 'Run', streamFn, onComplete = () => {}, onError, children, commandHint }) {
  const [status, setStatus]     = useState('idle');
  const [lines, setLines]       = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const streamRef   = useRef(null);
  const logRef      = useRef(null);
  const counterRef  = useRef(0);
  const deadRef     = useRef(false);

  const { openChat } = useContext(ChatContext) ?? {};

  const errorLines = useMemo(
    () => (status === 'error' ? extractErrorLines(lines) : []),
    [status, lines],
  );

  const askAi = () => {
    if (!openChat) return;
    const tail = lines.slice(-30).map((l) => l.text).join('\n');
    const summary = errorLines.length > 0 ? errorLines.join('\n') : '(no obvious error lines)';
    openChat(
      `${label} failed with exit code ${exitCode ?? '?'}${commandHint ? ` (\`${commandHint}\`)` : ''}.\n\n` +
      `Detected errors:\n${summary}\n\n` +
      `Last 30 log lines:\n\`\`\`\n${tail}\n\`\`\`\n\n` +
      `What's the root cause and how do I fix it?`,
    );
  };

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      deadRef.current = true;
      streamRef.current?.close();
    };
  }, []);

  const reset = () => {
    streamRef.current?.close();
    streamRef.current = null;
    counterRef.current = 0;
    setStatus('idle');
    setLines([]);
    setExitCode(null);
  };

  const run = () => {
    if (!streamFn) return;
    setStatus('running');
    setLines([]);
    setExitCode(null);
    counterRef.current = 0;

    const s = streamFn();
    streamRef.current = s;

    s.onmessage = ({ data: msg }) => {
      if (deadRef.current) return;
      if (msg.type === 'log') {
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        const ok = msg.exitCode === 0;
        setStatus(ok ? 'done' : 'error');
        setExitCode(msg.exitCode);
        streamRef.current = null;
        if (ok) onComplete(msg.content);
      } else if (msg.type === 'error') {
        setStatus('error');
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: `Error: ${msg.message}` }]);
        if (onError) onError(msg.message ?? 'Unknown error');
        streamRef.current = null;
      }
    };

    s.onerror = (err) => {
      if (deadRef.current) return;
      setStatus('error');
      const id = counterRef.current++;
      const errMsg = err.message || 'unknown';
      setLines((prev) => [...prev, { id, text: `Connection error: ${errMsg}` }]);
      if (onError) onError(`Connection error: ${errMsg}`);
      streamRef.current = null;
    };
  };

  return (
    <div className="cmd-runner">
      <div className="cmd-runner-head">
        <IconTerminal size={14} style={{ color: 'var(--fg-muted)' }} />
        <span className="cmd-runner-title">{label}</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {status === 'idle' && (
            <button className="btn btn-primary btn-sm" onClick={run}>
              <IconPlay size={11} /> {startLabel}
            </button>
          )}
          {status === 'running' && (
            <>
              <div className="live-dot">running</div>
              <button className="btn btn-ghost btn-sm" onClick={reset}>
                <IconX size={11} /> Cancel
              </button>
            </>
          )}
          {status === 'done' && (
            <>
              <span className="badge badge-success"><span className="badge-dot" />Complete</span>
              <button className="btn btn-ghost btn-sm" onClick={reset}>
                <IconRefresh size={11} /> Run again
              </button>
            </>
          )}
          {status === 'error' && (
            <>
              <span className="badge badge-error">
                <span className="badge-dot" />
                {exitCode != null ? `Exit ${exitCode}` : 'Failed'}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={reset}>
                <IconRefresh size={11} /> Run again
              </button>
            </>
          )}
        </div>
      </div>

      {children && (
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
          {children}
        </div>
      )}

      {status === 'error' && (
        <div
          style={{
            margin: '10px 14px 0',
            padding: '10px 12px',
            background: 'var(--status-conflict-bg)',
            border: '1px solid var(--status-conflict-border)',
            borderRadius: 'var(--r-md)',
            color: 'var(--status-conflict-fg)',
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 6, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
            <span>{label} failed{exitCode != null ? ` \u00B7 exit ${exitCode}` : ''}</span>
            {openChat && (
              <button
                className="btn btn-ghost btn-xs"
                onClick={askAi}
                style={{ color: 'var(--status-conflict-fg)' }}
                title="Open the chat with this failure as context"
              >
                \uD83E\uDD16 Ask AI
              </button>
            )}
          </div>
          {errorLines.length > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18, fontFamily: 'var(--font-mono)', fontSize: 11, lineHeight: 1.5 }}>
              {errorLines.map((line, i) => (
                <li key={i} style={{ wordBreak: 'break-word' }}>{line}</li>
              ))}
            </ul>
          ) : (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              No structured error lines detected \u2014 see the terminal log below.
            </div>
          )}
        </div>
      )}

      {lines.length > 0 && (
        <div className="cmd-terminal" ref={logRef}>
          {lines.map(({ id, text }) => (
            <div key={id} className="cmd-line">{text || '\u00A0'}</div>
          ))}
        </div>
      )}
    </div>
  );
}
