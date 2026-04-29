import { useState, useEffect } from 'react';
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
  const [tests, setTests]       = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [drift, setDrift]       = useState(null);
  const [loading, setLoading]   = useState(true);

  useEffect(() => {
    Promise.all([api.testRuns(), api.preflight(), api.drift()])
      .then(([t, p, d]) => { setTests(t); setPreflight(p); setDrift(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const totalPassed = tests?.runs?.reduce((s, r) => s + (r.passed ?? 0), 0) ?? 0;
  const totalFailed = tests?.runs?.reduce((s, r) => s + (r.failed ?? 0), 0) ?? 0;
  const lastTest    = tests?.runs?.[0];
  const lastTestDate = lastTest ? new Date(lastTest.date).toLocaleDateString() : '—';
  const threshold   = project?.coverageThreshold ?? 75;

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

  // Build a lightweight activity list from available data
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
  if (drift?.result) {
    activity.push({
      type: drift.result === 'clean' ? 'success' : 'warn',
      title: `Drift check — ${drift.count ?? 0} component${(drift.count ?? 0) !== 1 ? 's' : ''} differ`,
      meta: drift.date ? new Date(drift.date).toLocaleString() : '',
      status: drift.result,
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

      {/* Stats */}
      <div className="stats-grid">
        <StatCard label="Tests Passed"  value={totalPassed}  accent={totalPassed > 0 ? 'green' : 'brand'} />
        <StatCard label="Tests Failed"  value={totalFailed}  accent={totalFailed > 0 ? 'red' : 'green'} />
        <StatCard label="Coverage"      value={`${threshold}%`} sub="target threshold" accent="brand" />
        <StatCard label="Last Test"     value={lastTestDate}  sub={lastTest ? new Date(lastTest.date).toLocaleTimeString() : undefined} accent="violet" />
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
          {!tests?.runs?.length ? (
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
                {tests.runs.slice(0, 5).map((run, i) => (
                  <tr key={i}>
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
