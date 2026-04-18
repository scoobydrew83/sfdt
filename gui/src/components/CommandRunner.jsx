import { useState, useRef, useEffect } from 'react';
import { IconPlay, IconX, IconRefresh, IconTerminal } from '../Icons.jsx';

export default function CommandRunner({ command, label, onComplete = () => {} }) {
  const [status, setStatus]     = useState('idle');
  const [lines, setLines]       = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const esRef      = useRef(null);
  const logRef     = useRef(null);
  const counterRef = useRef(0);
  const deadRef    = useRef(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      deadRef.current = true;
      esRef.current?.close();
    };
  }, []);

  const reset = () => {
    esRef.current?.close();
    esRef.current = null;
    counterRef.current = 0;
    setStatus('idle');
    setLines([]);
    setExitCode(null);
  };

  const run = () => {
    setStatus('running');
    setLines([]);
    setExitCode(null);
    counterRef.current = 0;

    const es = new EventSource(`/api/command/run?command=${encodeURIComponent(command)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      if (deadRef.current) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'log') {
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        const ok = msg.exitCode === 0;
        setStatus(ok ? 'done' : 'error');
        setExitCode(msg.exitCode);
        es.close();
        esRef.current = null;
        if (ok) onComplete();
      } else if (msg.type === 'error') {
        setStatus('error');
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

  const terminal = lines.length > 0 && (
    <div className="cmd-terminal" ref={logRef}>
      {lines.map(({ id, text }) => (
        <div key={id} className="cmd-line">{text || '\u00A0'}</div>
      ))}
    </div>
  );

  return (
    <div className="cmd-runner">
      <div className="cmd-runner-head">
        <IconTerminal size={14} style={{ color: 'var(--fg-muted)' }} />
        <span className="cmd-runner-title">{label}</span>

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {status === 'idle' && (
            <button className="btn btn-primary btn-sm" onClick={run}>
              <IconPlay size={11} /> Run
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

      {terminal}
    </div>
  );
}
