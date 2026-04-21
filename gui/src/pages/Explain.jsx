import { useState } from 'react';
import StreamRunner from '../components/StreamRunner.jsx';
import { stream } from '../api.js';

export default function ExplainPage() {
  const [logPath, setLogPath] = useState('');

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
        </div>
      </StreamRunner>
    </div>
  );
}
