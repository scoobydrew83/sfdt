import { useState, useEffect, useCallback, useContext } from 'react';
import { api } from '../api.js';
import { ChatContext } from '../App.jsx';
import StatCard from '../components/StatCard.jsx';
import CommandRunner from '../components/CommandRunner.jsx';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatLineRanges(lines) {
  if (!lines || lines.length === 0) return '';
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0], end = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === end + 1) { end = sorted[i]; }
    else { ranges.push(start === end ? `${start}` : `${start}–${end}`); start = end = sorted[i]; }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(', ');
}

// ─── FailingTestsModal ────────────────────────────────────────────────────────

function FailingTestsModal({ run, classData, onClose }) {
  const { openChat } = useContext(ChatContext);

  // run.tests is an array of { name, status, message, durationMs }
  // Test class names follow the convention: ProdClassName + 'Test' (e.g. LightningLoginFormControllerTest)
  // classData is the classCoverage entry with .name, .percent
  const allTests = run?.tests?.filter((t) => {
    const testClass = t.name?.split('.')?.[0] ?? '';
    return testClass.toLowerCase().startsWith(classData.name.toLowerCase());
  }) ?? [];
  const failing  = allTests.filter((t) => t.status === 'fail');
  const passing  = allTests.filter((t) => t.status !== 'fail');

  const handleAskAI = () => {
    const lines = failing.map((t) => `- ${t.name}: ${t.message ?? '(no message)'}`).join('\n');
    openChat(`These tests are failing in \`${classData.name}\` (${classData.percent}% coverage):\n${lines}\n\nCan you read the source and suggest fixes?`);
    onClose();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={onClose}
    >
      <div
        style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 8, padding: 24, minWidth: 480, maxWidth: 680, maxHeight: '80vh', overflow: 'auto', boxShadow: 'var(--shadow-lg)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, flex: 1 }}>{classData.name}</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', marginBottom: 16 }}>
          {passing.length} passing · {failing.length} failing · {classData.percent}% coverage
        </p>
        {failing.length > 0 && (
          <>
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Test Method</th>
                  <th>Error</th>
                  <th>Duration</th>
                </tr>
              </thead>
              <tbody>
                {failing.map((t, i) => (
                  <tr key={i}>
                    <td className="td-mono" style={{ fontSize: 'var(--fs-xs)' }}>{t.name}</td>
                    <td style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-conflict-fg)', maxWidth: 300, wordBreak: 'break-word' }}>
                      {t.message ? (t.message.length > 120 ? t.message.slice(0, 120) + '…' : t.message) : '—'}
                    </td>
                    <td style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', whiteSpace: 'nowrap' }}>
                      {t.durationMs != null ? `${t.durationMs}ms` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="btn btn-primary btn-sm" onClick={handleAskAI}>✦ Ask AI to fix</button>
          </>
        )}
        {failing.length === 0 && passing.length > 0 && (
          <p style={{ color: 'var(--status-identical-fg)', fontSize: 'var(--fs-sm)' }}>All tests passing for this class.</p>
        )}
        {allTests.length === 0 && (
          <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>No test detail available for this class.</p>
        )}
        {classData.uncoveredLines?.length > 0 && (
          <div style={{ marginTop: 16 }}>
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', marginBottom: 6 }}>
              <strong style={{ color: 'var(--status-conflict-fg)' }}>Uncovered lines</strong>
              {' '}({classData.uncoveredLines.length})
            </p>
            <p style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color: 'var(--fg-default)', lineHeight: 1.7, margin: 0, wordBreak: 'break-word' }}>
              {formatLineRanges(classData.uncoveredLines)}
            </p>
          </div>
        )}
        {classData.uncoveredLines?.length === 0 && classData.totalLines > 0 && (
          <p style={{ color: 'var(--status-identical-fg)', fontSize: 'var(--fs-sm)', marginTop: 12 }}>All lines covered.</p>
        )}
      </div>
    </div>
  );
}

// ─── CoveragePage ─────────────────────────────────────────────────────────────

const LEVEL_LABELS = {
  RunLocalTests:     'Run Local Tests',
  RunAllTestsInOrg:  'Run All Tests in Org',
  RunSpecifiedTests: 'Run Specified Classes',
};

export default function CoveragePage() {
  const [testLevel, setTestLevel]         = useState('RunLocalTests');
  const [orgs, setOrgs]                   = useState([]);
  const [selectedOrg, setSelectedOrg]     = useState('');
  const [runs, setRuns]                   = useState([]);
  const [selectedRun, setSelectedRun]     = useState(null);  // null = latest
  const [filter, setFilter]               = useState('');
  const [belowOnly, setBelowOnly]         = useState(false);
  const [sortCol, setSortCol]             = useState('coverage');
  const [sortDir, setSortDir]             = useState('asc');
  const [syncing, setSyncing]             = useState(false);
  const [syncMsg, setSyncMsg]             = useState('');
  const [selectedClass, setSelectedClass] = useState(null);

  // Load test runs and orgs on mount
  useEffect(() => {
    api.testRuns().then(({ runs: r }) => setRuns(r ?? [])).catch(() => {});
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setSelectedOrg(list[0].alias);
      })
      .catch(() => {});
  }, []);

  const handleRefresh = useCallback(() => {
    api.testRuns().then(({ runs: r }) => setRuns(r ?? [])).catch(() => {});
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const r = await api.syncTestClasses();
      setSyncMsg(`Added ${r.added} · Removed ${r.removed} · Total ${r.total} classes`);
      setTimeout(() => setSyncMsg(''), 5000);
    } catch (err) {
      setSyncMsg(err.message ?? 'Sync failed');
      setTimeout(() => setSyncMsg(''), 5000);
    } finally {
      setSyncing(false);
    }
  };

  // ── Derived values ──────────────────────────────────────────────────────────

  const threshold     = 75;  // hardcoded; config isn't passed to page components
  const activeRun     = selectedRun ?? runs[0] ?? null;
  const classCoverage = activeRun?.classCoverage ?? [];
  const last          = activeRun?.coverage ?? null;   // overall coverage %
  const lastDate      = activeRun ? new Date(activeRun.date).toLocaleDateString() : '—';
  const belowCount    = classCoverage.filter((c) => c.percent < threshold).length;

  const coverageAccent = (pct) =>
    pct == null ? 'neutral' : pct >= threshold ? 'green' : pct >= 60 ? 'yellow' : 'red';

  // Filtered + sorted class list
  let displayed = classCoverage
    .filter((c) => !belowOnly || c.percent < threshold)
    .filter((c) => c.name.toLowerCase().includes(filter.toLowerCase()));

  displayed = [...displayed].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1;
    if (sortCol === 'coverage') return mul * (a.percent - b.percent);
    if (sortCol === 'name')     return mul * a.name.localeCompare(b.name);
    if (sortCol === 'covered')  return mul * (a.coveredLines - b.coveredLines);
    return 0;
  });

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Coverage</h1>
      </div>

      {/* ── Zone 1: Run Panel ─────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div className="card-title">Run Coverage</div></div>
        <div style={{ padding: '12px 16px 16px' }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, marginBottom: 8, flexWrap: 'wrap' }}>
            <div className="input-field">
              <label className="input-label">Test Level</label>
              <select
                value={testLevel}
                onChange={(e) => setTestLevel(e.target.value)}
                className="input"
              >
                <option value="RunLocalTests">Run Local Tests</option>
                <option value="RunAllTestsInOrg">Run All Tests in Org</option>
                <option value="RunSpecifiedTests">Run Specified Classes</option>
              </select>
            </div>
            <div className="input-field">
              <label className="input-label">Org</label>
              <select
                value={selectedOrg}
                onChange={(e) => setSelectedOrg(e.target.value)}
                className="input"
                disabled={orgs.length === 0}
              >
                {orgs.length === 0
                  ? <option value="">No orgs available</option>
                  : orgs.map((o) => <option key={o.alias} value={o.alias}>{o.alias}</option>)
                }
              </select>
            </div>
            <button
              className="btn btn-ghost btn-sm"
              style={{ alignSelf: 'flex-end', marginBottom: 1 }}
              onClick={handleSync}
              disabled={syncing}
            >
              {syncing ? 'Syncing…' : 'Sync from Source'}
            </button>
          </div>
          {testLevel === 'RunAllTestsInOrg' && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--status-modified-fg)', marginBottom: 8 }}>
              This may take 10+ minutes depending on org size.
            </p>
          )}
          {syncMsg && (
            <p style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', marginBottom: 8 }}>{syncMsg}</p>
          )}
          <CommandRunner
            command="test"
            label={LEVEL_LABELS[testLevel]}
            extraParams={{ testLevel, ...(selectedOrg ? { targetOrg: selectedOrg } : {}) }}
            onComplete={handleRefresh}
          />
        </div>
      </div>

      {/* ── Zone 2: Stat Cards ────────────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <StatCard label="Last Coverage"   value={last != null ? `${last}%` : '—'} accent={coverageAccent(last)} />
        <StatCard label="Threshold"       value={`${threshold}%`} accent="neutral" />
        <StatCard label="Below Threshold" value={belowCount} accent={belowCount > 0 ? 'red' : 'green'} />
        <StatCard label="Last Run"        value={lastDate} accent="neutral" />
      </div>

      {/* ── Zone 3: Trend ─────────────────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div className="card-title">Coverage Trend</div></div>
        <div style={{ padding: '8px 16px 16px' }}>
          {runs.length < 2 ? (
            <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
              Run coverage a few times to see trends
            </p>
          ) : (
            runs.slice(0, 10).map((run) => {
              const pct = run.coverage ?? 0;
              const barColor = pct >= threshold
                ? 'var(--status-identical-fg)'
                : pct >= 60
                  ? 'var(--status-modified-fg)'
                  : 'var(--status-conflict-fg)';
              const isSelected = selectedRun?.date === run.date;
              return (
                <div
                  key={run.date}
                  onClick={() => setSelectedRun(isSelected ? null : run)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '6px 8px',
                    borderRadius: 4,
                    cursor: 'pointer',
                    background: isSelected ? 'var(--bg-subtle)' : 'transparent',
                    marginBottom: 2,
                  }}
                >
                  <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', width: 90, flexShrink: 0 }}>
                    {new Date(run.date).toLocaleDateString()}
                  </span>
                  <div style={{ flex: 1, height: 8, background: 'var(--border-subtle)', borderRadius: 4, overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: barColor, borderRadius: 4 }} />
                  </div>
                  <span style={{ fontSize: 'var(--fs-xs)', fontFamily: 'var(--font-mono)', width: 36, textAlign: 'right', color: barColor }}>
                    {pct}%
                  </span>
                  {run.file && (
                    <button
                      className="btn btn-ghost btn-sm"
                      style={{ padding: '0 4px', lineHeight: 1, color: 'var(--fg-muted)', flexShrink: 0 }}
                      title="Delete this run"
                      onClick={async (e) => {
                        e.stopPropagation();
                        await api.deleteTestRun(run.file);
                        handleRefresh();
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* ── Zone 4: Per-Class Table ───────────────────────────────────────── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><div className="card-title">Per-Class Coverage</div></div>
        <div style={{ padding: '8px 16px 4px', display: 'flex', gap: 12, alignItems: 'center' }}>
          <input
            className="input"
            placeholder="Filter by class name"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--fs-sm)', cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input
              type="checkbox"
              checked={belowOnly}
              onChange={(e) => setBelowOnly(e.target.checked)}
            />
            Below threshold only
          </label>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                {[['name', 'Class Name'], ['coverage', 'Coverage'], ['covered', 'Covered'], ['total', 'Total']].map(([col, label]) => (
                  <th
                    key={col}
                    style={{ cursor: 'pointer' }}
                    onClick={() => {
                      if (sortCol === col) setSortDir((d) => d === 'asc' ? 'desc' : 'asc');
                      else { setSortCol(col); setSortDir('asc'); }
                    }}
                  >
                    {label}{sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.length === 0 ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center', color: 'var(--fg-muted)', padding: 16 }}>
                    {classCoverage.length === 0
                      ? 'Coverage detail not available for this run'
                      : 'No classes match your filter'}
                  </td>
                </tr>
              ) : displayed.map((c) => {
                const color = c.percent >= threshold
                  ? 'var(--status-identical-fg)'
                  : c.percent >= 60
                    ? 'var(--status-modified-fg)'
                    : 'var(--status-conflict-fg)';
                return (
                  <tr key={c.name} style={{ cursor: 'pointer' }} onClick={() => setSelectedClass(c)}>
                    <td className="td-mono" style={{ color: c.percent < threshold ? 'var(--status-conflict-fg)' : 'inherit' }}>
                      {c.name}
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ width: 60, height: 6, background: 'var(--border-subtle)', borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${c.percent}%`, height: '100%', background: color, borderRadius: 3 }} />
                        </div>
                        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', color }}>{c.percent}%</span>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{c.coveredLines}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{c.totalLines}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Failing Tests Modal ───────────────────────────────────────────── */}
      {selectedClass && (
        <FailingTestsModal
          run={activeRun}
          classData={selectedClass}
          onClose={() => setSelectedClass(null)}
        />
      )}
    </div>
  );
}
