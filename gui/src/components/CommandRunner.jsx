import { useState, useRef, useEffect, useContext, useMemo } from 'react';
import { IconPlay, IconX, IconRefresh, IconTerminal } from '../Icons.jsx';
import { stream } from '../api.js';
import { ChatContext } from '../App.jsx';

// Patterns that mark a line as a meaningful failure signal in deploy/validate
// streams. Ordered by priority — the first match wins for the summary line.
const ERROR_PATTERNS = [
  /\bComponent validation failed\b/i,
  /\bDeployment failed\b/i,
  /\bTest failure\b/i,
  /\bAPEX_FATAL_ERROR\b/i,
  /\bAPEX_ERROR\b/i,
  /\bFATAL_ERROR\b/i,
  /\b(?:error):\s+/i,
  /\bcannot deploy\b/i,
  /\bINVALID_(?:FIELD|TYPE|CROSS_REFERENCE_KEY|SESSION_ID|QUERY)/i,
  /\bUNABLE_TO_LOCK_ROW\b/i,
  /\bMETADATA_NOT_FOUND\b/i,
  /\bFAILED\b/,
];

function extractErrorLines(lines) {
  const matches = [];
  for (const line of lines) {
    const text = String(line.text ?? '');
    if (ERROR_PATTERNS.some((re) => re.test(text))) {
      matches.push(text.trim());
      if (matches.length >= 8) break;
    }
  }
  return matches;
}

export default function CommandRunner({ command, label, extraParams = {}, onComplete = () => {} }) {
  const [status, setStatus]     = useState('idle');
  const [lines, setLines]       = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const esRef      = useRef(null);
  const logRef     = useRef(null);
  const counterRef = useRef(0);
  const deadRef    = useRef(false);

  // openChat is available everywhere CommandRunner mounts; the App-level
  // provider wraps the whole tree.
  const { openChat } = useContext(ChatContext) ?? {};

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

    const es = stream.commandRun(command, extraParams);
    esRef.current = es;

    es.onmessage = (e) => {
      if (deadRef.current) return;
      const msg = e.data;

      if (msg.type === 'log') {
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        const ok = msg.exitCode === 0;
        setStatus(ok ? 'done' : 'error');
        setExitCode(msg.exitCode);
        es.close();
        esRef.current = null;
        onComplete(msg.exitCode);
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

  const errorLines = useMemo(
    () => (status === 'error' ? extractErrorLines(lines) : []),
    [status, lines],
  );

  const askAi = () => {
    if (!openChat) return;
    const tail = lines.slice(-30).map((l) => l.text).join('\n');
    const summary = errorLines.length > 0 ? errorLines.join('\n') : '(no obvious error lines)';
    openChat(
      `The "${label}" command (\`${command}\`) failed with exit code ${exitCode ?? '?'}.\n\n` +
      `Detected errors:\n${summary}\n\n` +
      `Last 30 log lines:\n\`\`\`\n${tail}\n\`\`\`\n\n` +
      `What's the root cause and how do I fix it?`,
    );
  };

  const failurePanel = status === 'error' && (
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
        <span>
          Command failed{exitCode != null ? ` \u00B7 exit ${exitCode}` : ''}
        </span>
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
  );

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

      {failurePanel}
      {terminal}
    </div>
  );
}

export { extractErrorLines };
