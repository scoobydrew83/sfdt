import { useState, useContext } from 'react';
import StreamRunner from '../components/StreamRunner.jsx';
import { stream } from '../api.js';
import { ChatContext } from '../App.jsx';

export default function ExplainPage() {
  const [logPath, setLogPath] = useState('');
  const [result, setResult] = useState(null);
  const chat = useContext(ChatContext);

  function handleComplete(content) {
    const analysis = (content ?? '').slice(0, 2000);
    setResult(analysis);
    chat?.setPageContext({
      page: 'Explain',
      data: { logFile: logPath || 'latest', analysis },
    });
  }

  const starterMessage =
    'I analyzed a deployment log and got this result. What should I fix first and what\'s the most likely root cause?';

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Explain</h1>
          <p className="page-subtitle">AI-powered analysis of Salesforce deployment error logs</p>
        </div>
      </div>

      <StreamRunner
        label="AI Log Analysis"
        startLabel="Analyze"
        streamFn={() => stream.explain(logPath || null)}
        onComplete={handleComplete}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
            Log file (optional)
          </label>
          <input
            className="input"
            style={{ flex: 1, fontSize: 12 }}
            value={logPath}
            onChange={(e) => setLogPath(e.target.value)}
            placeholder="logs/deploy-latest.log — leave blank to use latest"
          />
          {result !== null && chat && (
            <button
              onClick={() => chat?.openChat(starterMessage)}
              style={{
                fontSize: '12px',
                padding: '4px 10px',
                borderRadius: '6px',
                border: '1px solid var(--brand-300, #a5b4fc)',
                background: 'var(--brand-50, #eef2ff)',
                color: 'var(--brand-700, #4338ca)',
                cursor: 'pointer',
                marginLeft: '8px',
              }}
            >
              ✦ Ask AI about this log
            </button>
          )}
        </div>
      </StreamRunner>
    </div>
  );
}
