import { useState, useEffect, useContext } from 'react';
import CommandRunner from '../components/CommandRunner.jsx';
import StreamRunner from '../components/StreamRunner.jsx';
import { api, stream } from '../api.js';
import { ChatContext } from '../App.jsx';

const SEVERITY_LABELS = { 1: 'Critical', 2: 'High', 3: 'Medium', 4: 'Low' };
const SEVERITY_COLORS = {
  1: { bg: 'var(--danger-50, #fef2f2)', text: 'var(--danger-700, #b91c1c)', border: 'var(--danger-200, #fecaca)' },
  2: { bg: '#fff7ed', text: '#c2410c', border: '#fed7aa' },
  3: { bg: '#fefce8', text: '#a16207', border: '#fde68a' },
  4: { bg: 'var(--bg-card)', text: 'var(--fg-muted)', border: 'var(--border)' },
};

export default function QualityPage() {
  const [mode, setMode] = useState('analysis');
  const [result, setResult] = useState(null);
  const [streamKey, setStreamKey] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [qualityData, setQualityData] = useState(null);
  const chat = useContext(ChatContext);

  useEffect(() => {
    api.quality().then((d) => setQualityData(d)).catch(() => {});
  }, [refreshKey]);

  function handleFixPlanComplete(content) {
    const raw = content ?? '';
    const summary = raw.slice(0, 2000);
    setResult(raw.length > 2000 ? summary + `\n\n(truncated — ${raw.length} chars total)` : summary);
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

  const hasResults = qualityData && qualityData.date;
  const violations = qualityData?.violations ?? [];
  const summary = qualityData?.summary ?? { critical: 0, high: 0, medium: 0, low: 0 };

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
        <>
          <CommandRunner
            command="quality"
            label="Code Quality Analysis"
            onComplete={() => setRefreshKey((k) => k + 1)}
          />

          {hasResults && qualityData.unavailableMessage && (
            <div style={{
              marginTop: 16,
              padding: '12px 16px',
              background: '#fff7ed',
              border: '1px solid #fed7aa',
              borderRadius: 8,
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: '#c2410c', marginBottom: 4 }}>
                  sf scanner not installed — violation analysis unavailable
                </div>
                <div style={{ fontSize: 12, color: '#9a3412', fontFamily: 'monospace' }}>
                  sf plugins install @salesforce/sfdx-scanner
                </div>
                <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 4 }}>
                  The basic analysis above ran successfully. Install the scanner plugin to detect PMD and ESLint violations.
                </div>
              </div>
            </div>
          )}

          {hasResults && !qualityData.unavailableMessage && (
            <div style={{ marginTop: 16 }}>
              <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
                {[
                  { key: 'critical', label: 'Critical', sev: 1 },
                  { key: 'high',     label: 'High',     sev: 2 },
                  { key: 'medium',   label: 'Medium',   sev: 3 },
                  { key: 'low',      label: 'Low',      sev: 4 },
                ].map(({ key, label, sev }) => {
                  const c = SEVERITY_COLORS[sev];
                  return (
                    <div key={key} style={{
                      padding: '10px 18px',
                      borderRadius: 8,
                      border: `1px solid ${c.border}`,
                      background: c.bg,
                      minWidth: 90,
                      textAlign: 'center',
                    }}>
                      <div style={{ fontSize: 22, fontWeight: 700, color: c.text }}>{summary[key]}</div>
                      <div style={{ fontSize: 11, color: c.text, opacity: 0.8, marginTop: 2 }}>{label}</div>
                    </div>
                  );
                })}
                <div style={{
                  padding: '10px 18px',
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  minWidth: 90,
                  textAlign: 'center',
                }}>
                  <div style={{ fontSize: 22, fontWeight: 700, color: violations.length === 0 ? 'var(--success-600, #16a34a)' : 'var(--fg)' }}>
                    {violations.length === 0 ? '✓' : violations.length}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginTop: 2 }}>
                    {violations.length === 0 ? 'No Issues' : 'Total'}
                  </div>
                </div>
              </div>

              {violations.length > 0 ? (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', textAlign: 'left' }}>
                        <th style={{ padding: '8px 10px', color: 'var(--fg-muted)', fontWeight: 500 }}>Severity</th>
                        <th style={{ padding: '8px 10px', color: 'var(--fg-muted)', fontWeight: 500 }}>File</th>
                        <th style={{ padding: '8px 10px', color: 'var(--fg-muted)', fontWeight: 500 }}>Line</th>
                        <th style={{ padding: '8px 10px', color: 'var(--fg-muted)', fontWeight: 500 }}>Rule</th>
                        <th style={{ padding: '8px 10px', color: 'var(--fg-muted)', fontWeight: 500 }}>Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {violations.map((v, i) => {
                        const sev = Math.min(Math.max(v.severity, 1), 4);
                        const c = SEVERITY_COLORS[sev];
                        return (
                          <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '7px 10px' }}>
                              <span style={{
                                display: 'inline-block',
                                padding: '2px 7px',
                                borderRadius: 4,
                                background: c.bg,
                                color: c.text,
                                border: `1px solid ${c.border}`,
                                fontSize: 11,
                                fontWeight: 600,
                              }}>
                                {SEVERITY_LABELS[sev] ?? `Sev ${sev}`}
                              </span>
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--fg)', fontFamily: 'monospace', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {v.file ? v.file.split('/').pop() : '—'}
                            </td>
                            <td style={{ padding: '7px 10px', color: 'var(--fg-muted)' }}>{v.line || '—'}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--fg)', fontFamily: 'monospace' }}>{v.rule || '—'}</td>
                            <td style={{ padding: '7px 10px', color: 'var(--fg-muted)', maxWidth: 320 }}>{v.message || '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--fg-muted)', fontSize: 13 }}>
                  No violations found. Code looks clean.
                </div>
              )}

              {qualityData.date && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--fg-muted)', textAlign: 'right' }}>
                  Last scanned: {new Date(qualityData.date).toLocaleString()}
                </div>
              )}
            </div>
          )}
        </>
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
