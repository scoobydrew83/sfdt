import React, { useState, useEffect } from 'react';
import Card from '@salesforce/design-system-react/components/card';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: '24px' }}>
      <h2
        style={{
          fontSize: '13px',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          color: '#706e6b',
          marginBottom: '12px',
        }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

export default function Dashboard({ project }) {
  const [tests, setTests] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [drift, setDrift] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.testRuns(), api.preflight(), api.drift()])
      .then(([t, p, d]) => {
        setTests(t);
        setPreflight(p);
        setDrift(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const lastTest = tests?.runs?.[0];
  const totalPassed = tests?.runs?.reduce((s, r) => s + (r.passed ?? 0), 0) ?? 0;
  const totalFailed = tests?.runs?.reduce((s, r) => s + (r.failed ?? 0), 0) ?? 0;

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '60vh' }}>
        <Spinner size="large" variant="brand" />
      </div>
    );
  }

  return (
    <div style={{ padding: '28px 32px' }}>
      {/* Page header */}
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#032d60', margin: 0 }}>
          Dashboard
        </h1>
        {project?.org && (
          <div style={{ fontSize: '14px', color: '#706e6b', marginTop: '4px' }}>
            Connected org: <strong>{project.org}</strong>
          </div>
        )}
      </div>

      {/* Summary stats */}
      <Section title="Summary">
        <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
          <StatCard label="Tests Passed" value={totalPassed} accent="#2e844a" />
          <StatCard label="Tests Failed" value={totalFailed} accent={totalFailed > 0 ? '#ba0517' : '#2e844a'} />
          <StatCard
            label="Coverage Threshold"
            value={project?.coverageThreshold ? `${project.coverageThreshold}%` : '75%'}
            accent="#0176d3"
          />
          <StatCard
            label="Last Test Run"
            value={lastTest ? new Date(lastTest.date).toLocaleDateString() : '—'}
            sub={lastTest ? new Date(lastTest.date).toLocaleTimeString() : undefined}
            accent="#9050e9"
          />
        </div>
      </Section>

      {/* Recent activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
        {/* Test runs */}
        <Card
          heading="Recent Test Runs"
          style={{ background: '#fff', borderRadius: '8px' }}
        >
          <div style={{ padding: '0 16px 16px' }}>
            {!tests?.runs?.length ? (
              <p style={{ color: '#706e6b', fontSize: '14px', padding: '12px 0' }}>
                No test runs found. Run <code>sfdt test</code> to generate results.
              </p>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid #e5e5e5' }}>
                    <th style={{ textAlign: 'left', padding: '8px 4px', color: '#706e6b', fontWeight: 600 }}>Date</th>
                    <th style={{ textAlign: 'right', padding: '8px 4px', color: '#706e6b', fontWeight: 600 }}>Passed</th>
                    <th style={{ textAlign: 'right', padding: '8px 4px', color: '#706e6b', fontWeight: 600 }}>Failed</th>
                    <th style={{ textAlign: 'right', padding: '8px 4px', color: '#706e6b', fontWeight: 600 }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {tests.runs.slice(0, 5).map((run, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f3f3f3' }}>
                      <td style={{ padding: '8px 4px', color: '#3e3e3c' }}>
                        {new Date(run.date).toLocaleDateString()}
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right', color: '#2e844a', fontWeight: 600 }}>
                        {run.passed ?? 0}
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right', color: run.failed ? '#ba0517' : '#3e3e3c', fontWeight: run.failed ? 700 : 400 }}>
                        {run.failed ?? 0}
                      </td>
                      <td style={{ padding: '8px 4px', textAlign: 'right' }}>
                        <StatusBadge status={run.failed ? 'fail' : 'pass'} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </Card>

        {/* Preflight + Drift */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Card heading="Last Preflight Check">
            <div style={{ padding: '0 16px 16px' }}>
              {!preflight?.checks?.length ? (
                <p style={{ color: '#706e6b', fontSize: '14px', padding: '12px 0' }}>
                  No preflight data. Run <code>sfdt preflight</code>.
                </p>
              ) : (
                <>
                  <div style={{ marginBottom: '8px', fontSize: '12px', color: '#706e6b' }}>
                    {preflight.date ? new Date(preflight.date).toLocaleString() : ''}
                  </div>
                  {preflight.checks.slice(0, 4).map((c, i) => (
                    <div
                      key={i}
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '5px 0',
                        borderBottom: '1px solid #f3f3f3',
                        fontSize: '13px',
                      }}
                    >
                      <span style={{ color: '#3e3e3c' }}>{c.name}</span>
                      <StatusBadge status={c.status} />
                    </div>
                  ))}
                </>
              )}
            </div>
          </Card>

          <Card heading="Drift Status">
            <div style={{ padding: '0 16px 16px' }}>
              {!drift?.result ? (
                <p style={{ color: '#706e6b', fontSize: '14px', padding: '12px 0' }}>
                  No drift data. Run <code>sfdt drift</code>.
                </p>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '12px 0' }}>
                  <StatusBadge status={drift.result} />
                  <span style={{ fontSize: '13px', color: '#706e6b' }}>
                    {drift.date ? new Date(drift.date).toLocaleString() : ''}
                  </span>
                  {drift.count !== undefined && (
                    <span style={{ fontSize: '13px', color: '#706e6b' }}>
                      {drift.count} component{drift.count !== 1 ? 's' : ''} differ
                    </span>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
