import { useState, useEffect } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';

function CoverageCell({ pct }) {
  if (pct == null) return <span style={{ color: 'var(--fg-subtle)' }}>—</span>;
  const color = pct >= 75
    ? 'var(--status-identical-fg)'
    : pct >= 60
    ? 'var(--status-modified-fg)'
    : 'var(--status-conflict-fg)';
  return <span style={{ fontWeight: 600, color, fontFamily: 'var(--font-mono)' }}>{pct}%</span>;
}

function ClassCoverageTable({ rows, threshold = 75 }) {
  if (!rows || rows.length === 0) return null;
  return (
    <div style={{ padding: '0 0 12px 0', background: 'var(--bg-subtle)', borderBottom: '1px solid var(--border-subtle)' }}>
      <div style={{ padding: '8px 16px 4px', fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        Per-Class Coverage ({rows.length} classes)
      </div>
      <table className="data-table" style={{ fontSize: 12 }}>
        <thead>
          <tr>
            <th>Class</th>
            <th style={{ textAlign: 'right' }}>Covered</th>
            <th style={{ textAlign: 'right' }}>Total</th>
            <th style={{ textAlign: 'right' }}>Coverage</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => {
            const color = c.percent >= threshold
              ? 'var(--status-identical-fg)'
              : c.percent >= 60
              ? 'var(--status-modified-fg)'
              : 'var(--status-conflict-fg)';
            return (
              <tr key={c.name}>
                <td className="td-mono" style={{ color: c.percent < threshold ? 'var(--status-conflict-fg)' : 'inherit' }}>{c.name}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{c.coveredLines}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)', color: 'var(--fg-muted)' }}>{c.totalLines}</td>
                <td style={{ textAlign: 'right', fontWeight: 600, color, fontFamily: 'var(--font-mono)' }}>{c.percent}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ClassPicker({ onRun }) {
  const [configured, setConfigured] = useState([]);
  const [discovered, setDiscovered] = useState([]);
  const [selected, setSelected]     = useState(new Set());
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.testClasses()
      .then(({ configured: cfg = [], discovered: disc = [] }) => {
        if (cancelled) return;
        setConfigured(cfg);
        setDiscovered(disc);
        setSelected(new Set(cfg));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const toggle = (name) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(name) ? next.delete(name) : next.add(name);
    return next;
  });

  const allClasses = [...configured, ...discovered];
  const allSelected = allClasses.length > 0 && allClasses.every((c) => selected.has(c));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(allClasses));

  if (loading) return <div className="spinner-center"><div className="spinner" /></div>;

  if (allClasses.length === 0) {
    return (
      <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: '12px 0' }}>
        No test classes found. Add classes to <code>testConfig.testClasses</code> in{' '}
        <code>.sfdt/config.json</code>, or ensure your source path contains <code>*Test.cls</code> files.
      </div>
    );
  }

  const classes = (label, items, muted) => items.length === 0 ? null : (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>{label}</div>
      {items.map((name) => (
        <label key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', cursor: 'pointer' }}>
          <input type="checkbox" checked={selected.has(name)} onChange={() => toggle(name)} />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: muted ? 'var(--fg-muted)' : 'var(--fg-default)' }}>
            {name}
          </span>
        </label>
      ))}
    </div>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)' }}>
          <input type="checkbox" checked={allSelected} onChange={toggleAll} />
          Select all ({allClasses.length})
        </label>
        <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>{selected.size} selected</span>
      </div>
      {classes('Configured', configured, false)}
      {classes('Discovered in source', discovered, true)}
      <button
        className="btn btn-primary btn-sm"
        disabled={selected.size === 0}
        onClick={() => onRun([...selected].join(','))}
        style={{ marginTop: 4 }}
      >
        Run {selected.size} class{selected.size !== 1 ? 'es' : ''}
      </button>
    </div>
  );
}

function ManifestPicker({ onRun }) {
  const [manifests, setManifests]   = useState([]);
  const [selected, setSelected]     = useState('');
  const [detected, setDetected]     = useState(null);
  const [detecting, setDetecting]   = useState(false);
  const [loading, setLoading]       = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.listManifests()
      .then(({ manifests: m = [] }) => { if (!cancelled) setManifests(m); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const pickManifest = async (relPath) => {
    setSelected(relPath);
    setDetected(null);
    if (!relPath) return;
    setDetecting(true);
    try {
      const { tests = [] } = await api.detectTests(relPath);
      setDetected(tests);
    } catch {
      setDetected([]);
    } finally {
      setDetecting(false);
    }
  };

  if (loading) return <div className="spinner-center"><div className="spinner" /></div>;

  if (manifests.length === 0) {
    return (
      <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: '12px 0' }}>
        No manifests found. Generate one with <code>sfdt manifest</code>.
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', marginBottom: 4 }}>
          Package manifest
        </label>
        <select
          value={selected}
          onChange={(e) => pickManifest(e.target.value)}
          className="input"
          style={{ width: '100%', maxWidth: 420 }}
        >
          <option value="">— choose a manifest —</option>
          {manifests.map((m) => (
            <option key={m.relPath} value={m.relPath}>{m.name ?? m.relPath}</option>
          ))}
        </select>
      </div>

      {detecting && <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>Detecting test classes…</div>}

      {detected !== null && (
        detected.length === 0 ? (
          <div style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>
            No test classes detected in this manifest (looks for names ending in <code>Test</code> or <code>Tests</code>).
          </div>
        ) : (
          <div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 6 }}>
              Detected test classes ({detected.length})
            </div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', color: 'var(--fg-muted)', marginBottom: 12, lineHeight: 1.8 }}>
              {detected.join(', ')}
            </div>
            <button
              className="btn btn-primary btn-sm"
              onClick={() => onRun(detected.join(','))}
            >
              Run {detected.length} class{detected.length !== 1 ? 'es' : ''}
            </button>
          </div>
        )
      )}
    </div>
  );
}

function TestRunnerPanel({ onComplete }) {
  const [mode, setMode]           = useState('classes');
  const [classes, setClasses]     = useState(null);

  const handleRun = (classList) => setClasses(classList);
  const handleComplete = () => { setClasses(null); onComplete(); };
  const handleReset = () => setClasses(null);

  if (classes !== null) {
    return (
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head">
          <div className="card-title">Apex Test Run</div>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={handleReset}>
            ← Change selection
          </button>
        </div>
        <div style={{ padding: '0 16px 16px' }}>
          <CommandRunner
            command="test"
            label={`Running ${classes.split(',').length} class${classes.split(',').length !== 1 ? 'es' : ''}`}
            extraParams={{ classes }}
            onComplete={handleComplete}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="card-head">
        <div className="card-title">Apex Test Run</div>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            className={`btn btn-sm ${mode === 'classes' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('classes')}
          >
            Select Classes
          </button>
          <button
            className={`btn btn-sm ${mode === 'manifest' ? 'btn-primary' : 'btn-ghost'}`}
            onClick={() => setMode('manifest')}
          >
            From Manifest
          </button>
        </div>
      </div>
      <div style={{ padding: '12px 16px 16px' }}>
        {mode === 'classes'
          ? <ClassPicker onRun={handleRun} />
          : <ManifestPicker onRun={handleRun} />
        }
      </div>
    </div>
  );
}

export default function TestRuns() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [expandedRun, setExpandedRun] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.testRuns()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const runs       = data?.runs ?? [];
  const totalPass  = runs.reduce((s, r) => s + (r.passed ?? 0), 0);
  const totalFail  = runs.reduce((s, r) => s + (r.failed ?? 0), 0);
  const lastCov    = runs[0]?.coverage;
  const lastDate   = runs[0]?.date ? new Date(runs[0].date).toLocaleDateString() : '—';

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Test Runs</h1>
          <p className="page-subtitle">
            Select test classes or a manifest, then run. Results appear in the history below.
          </p>
        </div>
      </div>

      <TestRunnerPanel onComplete={() => setRefreshKey((k) => k + 1)} />

      {runs.length > 0 && (
        <div className="stats-grid mb-6">
          <StatCard label="Total Passed"   value={totalPass}  accent="green" />
          <StatCard label="Total Failed"   value={totalFail}  accent={totalFail > 0 ? 'red' : 'green'} />
          <StatCard label="Last Coverage"  value={lastCov != null ? `${lastCov}%` : '—'} accent="brand" />
          <StatCard label="Last Run"       value={lastDate}   accent="violet" />
        </div>
      )}

      {error && (
        <div className="alert alert-error mb-4">
          <span>Failed to load test results: {error}</span>
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && !error && runs.length === 0 && (
        <EmptyState
          title="No test runs yet"
          message="Choose test classes above and click Run to get started."
        />
      )}

      {!loading && !error && runs.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">Run History</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
              {runs.length} run{runs.length !== 1 ? 's' : ''}
            </div>
          </div>
          <div className="table-wrap" style={{ border: 'none', borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Passed</th>
                  <th style={{ textAlign: 'right' }}>Failed</th>
                  <th style={{ textAlign: 'right' }}>Errors</th>
                  <th>Coverage</th>
                  <th>Duration</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r, i) => {
                  const ok = !r.failed && !r.errors;
                  const hasClassData = r.classCoverage && r.classCoverage.length > 0;
                  const isExpanded = expandedRun === i;
                  return (
                    <>
                      <tr
                        key={i}
                        onClick={() => hasClassData && setExpandedRun(isExpanded ? null : i)}
                        style={{ cursor: hasClassData ? 'pointer' : 'default', background: isExpanded ? 'var(--bg-subtle)' : undefined }}
                      >
                        <td className="td-mono">
                          {hasClassData && (
                            <span style={{ marginRight: 6, fontSize: 10, color: 'var(--fg-muted)', display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
                          )}
                          {r.date ? new Date(r.date).toLocaleString() : '—'}
                        </td>
                        <td style={{ textAlign: 'right', color: 'var(--status-identical-fg)', fontWeight: 600 }}>{r.passed ?? 0}</td>
                        <td style={{ textAlign: 'right', color: r.failed ? 'var(--status-conflict-fg)' : 'var(--fg-muted)', fontWeight: r.failed ? 600 : 400 }}>{r.failed ?? 0}</td>
                        <td style={{ textAlign: 'right', color: r.errors ? 'var(--status-conflict-fg)' : 'var(--fg-muted)' }}>{r.errors ?? 0}</td>
                        <td><CoverageCell pct={r.coverage} /></td>
                        <td className="td-mono">{r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '—'}</td>
                        <td><StatusBadge status={ok ? 'pass' : 'fail'} /></td>
                      </tr>
                      {isExpanded && hasClassData && (
                        <tr key={`${i}-detail`}>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <ClassCoverageTable rows={r.classCoverage} />
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
