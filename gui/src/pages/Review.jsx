import { useState, useContext } from 'react';
import StreamRunner from '../components/StreamRunner.jsx';
import { stream } from '../api.js';
import { ChatContext } from '../App.jsx';

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

export default function ReviewPage() {
  const [base, setBase] = useState('main');
  const [streamKey, setStreamKey] = useState(0);
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const chat = useContext(ChatContext);

  function handleComplete(content) {
    const raw = content ?? '';
    const findings = raw.length > 2000 ? raw.slice(0, 2000) + `\n\n(truncated — ${raw.length} chars total)` : raw;
    setResult(findings);
    setErrorMsg(null);
    chat?.setPageContext({ page: 'Review', data: { baseBranch: base, findings } });
    setStreamKey((k) => k + 1);
  }

  const starterMessage = `I just ran a code review against ${base}. Can you summarize the most critical issues and suggest what to fix first?`;

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
        onComplete={handleComplete}
        onError={setErrorMsg}
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
              ✦ Ask AI about this review
            </button>
          )}
        </div>
      </StreamRunner>

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
    </div>
  );
}
