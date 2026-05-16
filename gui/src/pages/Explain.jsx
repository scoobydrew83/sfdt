import { useState, useRef, useEffect, useContext } from 'react';
import ReactMarkdown from 'react-markdown';
import { stream, api } from '../api.js';
import { ChatContext } from '../App.jsx';
import { IconTerminal, IconPlay, IconX, IconRefresh } from '../Icons.jsx';
const AI_CONFIG_HINT = (
  <div style={{ marginTop: 8, fontSize: 12, color: 'var(--status-modified-fg)' }}>
    <strong>To enable AI features:</strong> set <code>features.ai: true</code> and <code>ai.provider</code> in{' '}
    <code>.sfdt/config.json</code>. For Claude, install the Claude Code CLI. For OpenAI or Gemini, set{' '}
    <code>ai.apiKey</code>.
  </div>
);
function isAiError(msg) {
  return typeof msg === 'string' && (
    msg.toLowerCase().includes('not available') ||
    msg.toLowerCase().includes('not configured') ||
    msg.toLowerCase().includes('ai is')
  );
}
export default function ExplainPage() {
  const [status, setStatus]     = useState('idle');
  const [lines, setLines]       = useState([]);
  const [result, setResult]     = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const streamRef  = useRef(null);
  const counterRef = useRef(0);
  const deadRef    = useRef(false);
  const termRef    = useRef(null);
  const [logFiles, setLogFiles]         = useState(null);
  const [logsLoading, setLogsLoading]   = useState(false);
  const [selectedLog, setSelectedLog]   = useState('');
  const chat = useContext(ChatContext);
  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [lines]);
  useEffect(() => {
    return () => {
      deadRef.current = true;
      streamRef.current?.close();
    };
  }, []);
  function handleAdvancedToggle(e) {
    const open = e.target.open;
    if (open && logFiles === null && !logsLoading) {
      setLogsLoading(true);
      api.logsList()
        .then((data) => setLogFiles(data.files ?? []))
        .catch(() => setLogFiles([]))
        .finally(() => setLogsLoading(false));
    }
  }
  const reset = () => {
    streamRef.current?.close();
    streamRef.current = null;
    counterRef.current = 0;
    setStatus('idle');
    setLines([]);
    setResult(null);
    setErrorMsg(null);
  };
  const run = () => {
    reset();
    setStatus('running');
    counterRef.current = 0;
    const logPath = selectedLog || null;
    const s = stream.explain(logPath);
    streamRef.current = s;
    s.onmessage = ({ data: msg }) => {
      if (deadRef.current) return;
      if (msg.type === 'log') {
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        const ok = msg.exitCode === 0;
        setStatus(ok ? 'done' : 'error');
        streamRef.current = null;
        if (ok) {
          setResult({ content: msg.content ?? '', source: msg.source ?? 'ai' });
          chat?.setPageContext({
            page: 'Explain',
            data: { logFile: selectedLog || 'latest', analysis: msg.content },
          });
        } else {
          setErrorMsg(msg.content || `Process exited with code ${msg.exitCode}`);
        }
      } else if (msg.type === 'error') {
        setStatus('error');
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: `Error: ${msg.message}` }]);
        setErrorMsg(msg.message ?? 'Unknown error');
        streamRef.current = null;
      }
    };
    s.onerror = (err) => {
      if (deadRef.current) return;
      setStatus('error');
      const errMsg = `Connection error: ${err.message || 'unknown'}`;
      const id = counterRef.current++;
      setLines((prev) => [...prev, { id, text: errMsg }]);
      setErrorMsg(errMsg);
      streamRef.current = null;
    };
  };
  const terminalOpen = status === 'running' || status === 'error';
  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Explain</h1>
          <p className="page-subtitle">AI-powered analysis of Salesforce deployment error logs</p>
        </div>
      </div>
      {}
      <div className="cmd-runner">
        <div className="cmd-runner-head">
          <IconTerminal size={14} style={{ color: 'var(--fg-muted)' }} />
          <span className="cmd-runner-title">AI Log Analysis</span>
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
            {status === 'idle' && (
              <button className="btn btn-primary btn-sm" onClick={run}>
                <IconPlay size={11} /> Analyze
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
            {(status === 'done' || status === 'error') && (
              <>
                {status === 'done'
                  ? <span className="badge badge-success"><span className="badge-dot" />Complete</span>
                  : <span className="badge badge-error"><span className="badge-dot" />Failed</span>
                }
                <button className="btn btn-ghost btn-sm" onClick={reset}>
                  <IconRefresh size={11} /> Run again
                </button>
              </>
            )}
          </div>
        </div>
        <details
          style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)' }}
          onToggle={handleAdvancedToggle}
        >
          <summary style={{ fontSize: 12, color: 'var(--fg-muted)', cursor: 'pointer', userSelect: 'none' }}>
            Advanced — using {selectedLog || 'latest log'}
          </summary>
          <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
            <label style={{ fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>Log file</label>
            {logsLoading ? (
              <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Loading…</span>
            ) : logFiles !== null && logFiles.length > 0 ? (
              <select
                className="input"
                style={{ flex: 1, fontSize: 12 }}
                value={selectedLog}
                onChange={(e) => setSelectedLog(e.target.value)}
              >
                <option value="">Latest (auto-detect)</option>
                {logFiles.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                style={{ flex: 1, fontSize: 12 }}
                value={selectedLog}
                onChange={(e) => setSelectedLog(e.target.value)}
                placeholder="logs/deploy-latest.log — leave blank for latest"
              />
            )}
          </div>
        </details>
      </div>
      {}
      {lines.length > 0 && (
        <details open={terminalOpen} style={{ marginTop: 8 }}>
          <summary
            onClick={(e) => { if (terminalOpen) e.preventDefault(); }}
            style={{
              fontSize: 12,
              color: 'var(--fg-muted)',
              cursor: 'pointer',
              userSelect: 'none',
              padding: '6px 14px',
              background: 'var(--bg-subtle)',
              borderRadius: 6,
              border: '1px solid var(--border)',
            }}
          >
            {terminalOpen ? '▼' : '▶'} Raw output {!terminalOpen && `(${lines.length} lines)`}
          </summary>
          <div className="cmd-terminal" ref={termRef} style={{ marginTop: 4 }}>
            {lines.map(({ id, text }) => (
              <div key={id} className="cmd-line">{text || ' '}</div>
            ))}
          </div>
        </details>
      )}
      {}
      {errorMsg && (
        <div style={{
          marginTop: 12,
          padding: '12px 16px',
          background: 'var(--danger-50, #fef2f2)',
          border: '1px solid var(--danger-200, #fecaca)',
          borderRadius: 8,
          color: 'var(--danger-700, #b91c1c)',
        }}>
          <strong>Error:</strong> {errorMsg}
          {isAiError(errorMsg) && AI_CONFIG_HINT}
        </div>
      )}
      {}
      {result && (
        <div style={{
          marginTop: 16,
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-subtle)',
          }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Analysis Result</span>
            {result.source === 'ai'
              ? <span className="badge badge-ai"><span className="badge-dot" />AI Analysis</span>
              : <span className="badge badge-warning"><span className="badge-dot" />Heuristic Scan</span>
            }
          </div>
          <div className="result-body" style={{ padding: '16px', overflowX: 'auto' }}>
            <ReactMarkdown>{result.content}</ReactMarkdown>
          </div>
          {chat && (
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
            }}>
              <button
                onClick={() => chat.openChat("I analyzed a deployment log and got this result. What should I fix first and what's the most likely root cause?")}
                style={{
                  fontSize: '12px',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--brand-300, #a5b4fc)',
                  background: 'var(--brand-50, #eef2ff)',
                  color: 'var(--brand-700, #4338ca)',
                  cursor: 'pointer',
                }}
              >
                ✦ Ask AI about this log
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
