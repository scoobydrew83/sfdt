import { useState, useRef, useEffect } from 'react';
import { IconPlay, IconX, IconRefresh, IconTerminal } from '../Icons.jsx';

/**
 * Like CommandRunner but drives a POST-based SSE stream from api.stream.*.
 * Props:
 *   label        — title text
 *   startLabel   — button label (default "Run")
 *   streamFn     — () => stream object from api.stream.*
 *   onComplete   — called when exitCode === 0
 *   children     — optional content rendered above the terminal (form inputs, etc.)
 */
export default function StreamRunner({ label, startLabel = 'Run', streamFn, onComplete = () => {}, children }) {
  const [status, setStatus]     = useState('idle');
  const [lines, setLines]       = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const streamRef   = useRef(null);
  const logRef      = useRef(null);
  const counterRef  = useRef(0);
  const deadRef     = useRef(false);

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
        streamRef.current = null;
      }
    };

    s.onerror = (err) => {
      if (deadRef.current) return;
      setStatus('error');
      const id = counterRef.current++;
      setLines((prev) => [...prev, { id, text: `Connection error: ${err.message || 'unknown'}` }]);
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
