import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import { IconCheckCircle, IconXCircle, IconAlertTri, IconRefresh } from '../Icons.jsx';

function ActivityIcon({ type }) {
  if (type === 'success') return <div className="activity-ico success"><IconCheckCircle size={13} /></div>;
  if (type === 'warn')    return <div className="activity-ico warn"><IconAlertTri size={13} /></div>;
  if (type === 'error')   return <div className="activity-ico error"><IconXCircle size={13} /></div>;
  return <div className="activity-ico info"><IconRefresh size={13} /></div>;
}

export default function Dashboard({ project }) {
  const [tests, setTests]           = useState(null);
  const [preflight, setPreflight]   = useState(null);
  const [drift, setDrift]           = useState(null);
  const [deploys, setDeploys]       = useState(null);
  const [loading, setLoading]       = useState(true);
  const [fetchError, setFetchError] = useState(null);

  const loadData = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(null);
    Promise.all([api.testRuns(), api.preflight(), api.drift(), api.deployHistory()])
      .then(([t, p, d, dh]) => {
        if (cancelled) return;
        setTests(t);
        setPreflight(p);
        setDrift(d);
        setDeploys(dh);
      })
      .catch((err) => { if (!cancelled) setFetchError(err.message ?? 'Failed to load dashboard data.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const cancel = loadData();
    return cancel;
  }, [loadData]);

  // ─── Derived stat values ──────────────────────────────────────────────────

  // Test Runs card
  const testRuns    = tests?.runs ?? [];
  const testRunCount = testRuns.length;
  // Sparkline: last 7 pass-rates (0–100)
  const testSparkline = testRuns.slice(-7).map((r) => {
    const total = (r.passed ?? 0) + (r.failed ?? 0);
    return total > 0 ? Math.round(((r.passed ?? 0) / total) * 100) : 0;
  });
  const thisWeek = testRuns.filter((r) => {
    return r.date ? (Date.now() - new Date(r.date).getTime()) < 7 * 24 * 60 * 60 * 1000 : false;
  }).length;
  const testTrend = thisWeek > 0 ? `+${thisWeek} this week` : undefined;

  // Preflight card
  const preflightChecks = preflight?.checks ?? [];
  const preflightPassed = preflightChecks.filter((c) => c.status === 'pass').length;
  const preflightFailed = preflightChecks.filter((c) => c.status === 'fail' || c.status === 'error').length;
  const preflightTotal  = preflightChecks.length;
  const preflightSparkline = preflightTotal > 0
    ? Array(7).fill(preflightPassed)
    : undefined;
  const preflightTrend = preflightFailed > 0
    ? `${preflightFailed} failed`
    : preflightTotal > 0 ? 'All passed' : undefined;
  const preflightTrendColor = preflightFailed > 0 ? 'danger' : 'success';

  // Drift card
  const driftComponents = drift?.components ?? [];
  const driftedCount    = driftComponents.filter((c) => c.drift?.toLowerCase() === 'drift').length;
  const driftValue      = drift ? (driftedCount === 0 ? 'Clean' : driftedCount) : '—';
  const driftTrend      = drift
    ? (driftedCount > 0 ? `▲ ${driftedCount} drifted` : 'No drift')
    : undefined;
  const driftTrendColor = driftedCount > 0 ? 'danger' : 'success';
  const driftAccent     = !drift ? 'brand' : driftedCount > 0 ? 'red' : 'green';
  // Flat sparkline from single value
  const driftSparkline  = drift ? Array(7).fill(driftedCount) : undefined;

  // Deployments card
  const deployHistory   = deploys?.history ?? [];
  const deployCount     = deployHistory.length;
  const recentDeploys   = deployHistory.filter((d) => {
    return d.date ? (Date.now() - new Date(d.date).getTime()) < 7 * 24 * 60 * 60 * 1000 : false;
  }).length;
  const deploySparkline = deployHistory.slice(-7).map((d) => (d.exitCode === 0 ? 1 : 0));
  const deployTrend     = recentDeploys > 0 ? `+${recentDeploys} this week` : undefined;

  // ─── Loading skeleton ─────────────────────────────────────────────────────

  if (loading) {
    return (
      <div>
        <div className="page-header">
          <div className="page-header-text">
            <h1>Dashboard</h1>
            {project?.org && <p className="page-subtitle">{project.org}</p>}
          </div>
        </div>
        <div className="stats-grid">
          {[0,1,2,3].map((i) => (
            <div key={i} className="stat-card">
              <div className="skeleton" style={{ height: 12, width: '60%', marginBottom: 8 }} />
              <div className="skeleton" style={{ height: 28, width: '40%' }} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div>
        <div className="page-header">
          <div className="page-header-text">
            <h1>Dashboard</h1>
            {project?.org && <p className="page-subtitle">{project.org}</p>}
          </div>
        </div>
        <div className="alert alert-error" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span>Failed to load dashboard data: {fetchError}</span>
          <button className="btn btn-ghost btn-sm" onClick={loadData}>
            <IconRefresh size={12} /> Retry
          </button>
        </div>
      </div>
    );
  }

  // ─── Activity feed ────────────────────────────────────────────────────────
  const lastTest = testRuns[0];
  const activity = [];
  if (lastTest) {
    const ok = !lastTest.failed && !lastTest.errors;
    activity.push({
      type: ok ? 'success' : 'error',
      title: `Test run — ${lastTest.passed ?? 0} passed, ${lastTest.failed ?? 0} failed`,
      meta: new Date(lastTest.date).toLocaleString(),
      status: ok ? 'pass' : 'fail',
    });
  }
  if (preflight?.checks?.length) {
    const fail = preflight.checks.filter((c) => c.status === 'fail' || c.status === 'error').length;
    activity.push({
      type: fail ? 'warn' : 'success',
      title: `Preflight — ${preflight.checks.length} checks, ${fail} failed`,
      meta: preflight.date ? new Date(preflight.date).toLocaleString() : '',
      status: preflight.status,
    });
  }
  if (drift?.status) {
    activity.push({
      type: drift.status === 'clean' ? 'success' : 'warn',
      title: `Drift check — ${driftedCount} component${driftedCount !== 1 ? 's' : ''} differ`,
      meta: drift.date ? new Date(drift.date).toLocaleString() : '',
      status: drift.status,
    });
  }
  if (deployHistory.length > 0) {
    const last = deployHistory[0];
    activity.push({
      type: last.exitCode === 0 ? 'success' : 'error',
      title: `Deploy — ${last.manifest ?? 'unknown manifest'} → ${last.org ?? 'default org'}`,
      meta: last.date ? new Date(last.date).toLocaleString() : '',
      status: last.exitCode === 0 ? 'pass' : 'fail',
    });
  }

  return (
    <div className="page-content" style={{ padding: 0 }}>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Dashboard</h1>
          {project?.org && <p className="page-subtitle">Target Org: <span className="mono" style={{ color: 'var(--brand-600)', fontWeight: 600 }}>{project.org}</span></p>}
        </div>
      </div>

      {/* 4-up stat cards */}
      <div className="stats-grid">
        <StatCard
          label="Test Runs"
          value={testRunCount}
          sub={lastTest ? `Last: ${new Date(lastTest.date).toLocaleDateString()}` : 'No runs yet'}
          accent="brand"
          sparkline={testSparkline.length >= 2 ? testSparkline : undefined}
          trend={testTrend}
          trendColor="success"
        />
        <StatCard
          label="Preflight Checks"
          value={preflightTotal > 0 ? `${preflightPassed}/${preflightTotal}` : '—'}
          sub={preflightTotal > 0 ? 'passed' : 'No runs yet'}
          accent={preflightFailed > 0 ? 'red' : preflightTotal > 0 ? 'green' : 'brand'}
          sparkline={preflightSparkline}
          trend={preflightTrend}
          trendColor={preflightTrendColor}
        />
        <StatCard
          label="Drift Status"
          value={driftValue}
          sub={drift ? `${driftComponents.length} components checked` : 'No scan yet'}
          accent={driftAccent}
          sparkline={driftSparkline?.length >= 2 ? driftSparkline : undefined}
          trend={driftTrend}
          trendColor={driftTrendColor}
        />
        <StatCard
          label="Deployments"
          value={deployCount}
          sub={recentDeploys > 0 ? `${recentDeploys} this week` : 'No recent deploys'}
          accent="violet"
          sparkline={deploySparkline.length >= 2 ? deploySparkline : undefined}
          trend={deployTrend}
          trendColor="success"
        />
      </div>

      <div className="two-col" style={{ gap: 24 }}>

        {/* Recent tests */}
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Recent Test Runs</div>
              <div className="card-subtitle">Last 5 executions</div>
            </div>
          </div>
          {!testRuns.length ? (
            <div style={{ padding: 'var(--s-5)', color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>
              No test runs yet. Run <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-muted)', padding: '1px 5px', borderRadius: 3 }}>sfdt test</code>.
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th style={{ textAlign: 'right' }}>Passed</th>
                  <th style={{ textAlign: 'right' }}>Failed</th>
                  <th style={{ textAlign: 'right' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {testRuns.slice(0, 5).map((run, i) => (
                  <tr key={`${run.date}-${i}`}>
                    <td className="td-mono">{new Date(run.date).toLocaleDateString()}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: 'var(--status-identical-fg)', fontWeight: 600 }}>{run.passed ?? 0}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span style={{ color: run.failed ? 'var(--status-conflict-fg)' : 'var(--fg-muted)', fontWeight: run.failed ? 600 : 400 }}>
                        {run.failed ?? 0}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <StatusBadge status={run.failed ? 'fail' : 'pass'} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Activity + preflight */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>

          <div className="card">
            <div className="card-head">
              <div className="card-title">Recent Activity</div>
            </div>
            {activity.length === 0 ? (
              <div style={{ padding: 'var(--s-5)', color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>
                No activity yet.
              </div>
            ) : (
              <div className="activity-list">
                {activity.map((item, i) => (
                  <div key={i} className="activity-item">
                    <ActivityIcon type={item.type} />
                    <div>
                      <div className="activity-title">{item.title}</div>
                      <div className="activity-meta">{item.meta}</div>
                    </div>
                    {item.status && <StatusBadge status={item.status} />}
                  </div>
                ))}
              </div>
            )}
          </div>

          {preflight?.checks?.length > 0 && (
            <div className="card">
              <div className="card-head">
                <div className="card-title">Preflight Checks</div>
                {preflight.date && (
                  <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
                    {new Date(preflight.date).toLocaleDateString()}
                  </div>
                )}
              </div>
              <div>
                {preflight.checks.slice(0, 4).map((c, i) => (
                  <div
                    key={i}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '8px var(--s-4)',
                      borderBottom: i < Math.min(preflight.checks.length, 4) - 1 ? '1px solid var(--border-subtle)' : 'none',
                    }}
                  >
                    <span style={{ fontSize: 'var(--fs-sm)' }}>{c.name}</span>
                    <StatusBadge status={c.status} />
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
