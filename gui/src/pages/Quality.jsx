import { useState, useContext } from 'react';
import CommandRunner from '../components/CommandRunner.jsx';
import StreamRunner from '../components/StreamRunner.jsx';
import { stream } from '../api.js';
import { ChatContext } from '../App.jsx';

export default function QualityPage() {
  const [mode, setMode] = useState('analysis'); // 'analysis' | 'fixplan'
  const [result, setResult] = useState(null);
  const [streamKey, setStreamKey] = useState(0);
  const chat = useContext(ChatContext);

  function handleFixPlanComplete(content) {
    const summary = (content ?? '').slice(0, 2000);
    setResult(summary);
    chat?.setPageContext({ page: 'Quality', data: { fixPlan: summary } });
    setStreamKey((k) => k + 1);
  }

  const tabStyle = (active) => ({
    padding: '6px 14px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    background: active ? 'var(--brand-600, #4f46e5)' : 'var(--bg-card)',
    color: active ? '#fff' : 'var(--fg-muted)',
    fontSize: 12,
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
  });

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Quality</h1>
          <p className="page-subtitle">Run code quality analysis or get an AI-powered fix plan</p>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <button style={tabStyle(mode === 'analysis')} onClick={() => setMode('analysis')}>
          Analysis
        </button>
        <button style={tabStyle(mode === 'fixplan')} onClick={() => setMode('fixplan')}>
          ✦ AI Fix Plan
        </button>
      </div>

      {mode === 'analysis' && (
        <CommandRunner command="quality" label="Code Quality Analysis" />
      )}

      {mode === 'fixplan' && (
        <StreamRunner
          key={streamKey}
          label="AI Quality Fix Plan"
          startLabel="Generate Fix Plan"
          streamFn={() => stream.qualityFixPlan()}
          onComplete={handleFixPlanComplete}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
              Analyzes latest quality results and creates a prioritized fix plan
            </span>
            {result !== null && chat && (
              <button
                onClick={() => chat?.openChat('I just generated a quality fix plan. What should I prioritize fixing first, and can you help me with the most critical item?')}
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
                ✦ Ask AI about this plan
              </button>
            )}
          </div>
        </StreamRunner>
      )}
    </div>
  );
}
