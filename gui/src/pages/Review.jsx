import { useState } from 'react';
import StreamRunner from '../components/StreamRunner.jsx';
import { stream } from '../api.js';

export default function ReviewPage() {
  const [base, setBase] = useState('main');
  const [streamKey, setStreamKey] = useState(0);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Code Review</h1>
          <p className="page-subtitle">AI-powered Salesforce code review of branch changes</p>
        </div>
      </div>

      <StreamRunner
        key={streamKey}
        label="AI Code Review"
        startLabel="Start Review"
        streamFn={() => stream.review(base)}
        onComplete={() => setStreamKey((k) => k + 1)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-muted)', whiteSpace: 'nowrap' }}>
            Compare against
          </label>
          <input
            className="input"
            style={{ width: 180, fontSize: 12 }}
            value={base}
            onChange={(e) => setBase(e.target.value)}
            placeholder="main"
          />
        </div>
      </StreamRunner>
    </div>
  );
}
