import { useState, useEffect } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Card from '@salesforce/design-system-react/components/card';
import Icon from '@salesforce/design-system-react/components/icon';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';

export default function Dashboard({ project }) {
  const [tests, setTests] = useState(null);
  const [preflight, setPreflight] = useState(null);
  const [drift, setDrift] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api.testRuns(), api.preflight(), api.drift()])
      .then(([t, p, d]) => { setTests(t); setPreflight(p); setDrift(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const lastTest     = tests?.runs?.[0];
  const totalPassed  = tests?.runs?.reduce((s, r) => s + (r.passed ?? 0), 0) ?? 0;
  const totalFailed  = tests?.runs?.reduce((s, r) => s + (r.failed ?? 0), 0) ?? 0;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        label="SFDT"
        info={project?.org ? `Connected org: ${project.org}` : undefined}
        variant="object-home"
        icon={
          <Icon
            assistiveText={{ label: 'Dashboard' }}
            category="utility"
            name="home"
            size="large"
          />
        }
      />

      {loading ? (
        <div style={{ position: 'relative', height: '300px' }}>
          <Spinner size="large" variant="brand" />
        </div>
      ) : (
        <div className="slds-p-around_large">

          {/* ── Summary stats ──────────────────────────────────────────── */}
          <p className="slds-text-title_caps slds-text-color_weak slds-m-bottom_small">
            Summary
          </p>
          <div className="slds-grid slds-wrap slds-gutters slds-m-bottom_large">
            <div className="slds-col slds-size_1-of-2 slds-medium-size_1-of-4">
              <StatCard
                label="Tests Passed"
                value={totalPassed}
                accent="#2e844a"
                iconName="check"
              />
            </div>
            <div className="slds-col slds-size_1-of-2 slds-medium-size_1-of-4">
              <StatCard
                label="Tests Failed"
                value={totalFailed}
                accent={totalFailed > 0 ? '#ba0517' : '#2e844a'}
                iconName={totalFailed > 0 ? 'close' : 'check'}
              />
            </div>
            <div className="slds-col slds-size_1-of-2 slds-medium-size_1-of-4">
              <StatCard
                label="Coverage Threshold"
                value={project?.coverageThreshold ? `${project.coverageThreshold}%` : '75%'}
                accent="#0176d3"
                iconName="chart"
              />
            </div>
            <div className="slds-col slds-size_1-of-2 slds-medium-size_1-of-4">
              <StatCard
                label="Last Test Run"
                value={lastTest ? new Date(lastTest.date).toLocaleDateString() : '—'}
                sub={lastTest ? new Date(lastTest.date).toLocaleTimeString() : undefined}
                accent="#9050e9"
                iconName="clock"
              />
            </div>
          </div>

          {/* ── Recent activity ────────────────────────────────────────── */}
          <p className="slds-text-title_caps slds-text-color_weak slds-m-bottom_small">
            Recent Activity
          </p>
          <div className="slds-grid slds-wrap slds-gutters">

            {/* Recent test runs */}
            <div className="slds-col slds-size_1-of-1 slds-medium-size_1-of-2">
              <Card
                heading="Recent Test Runs"
                icon={
                  <Icon
                    assistiveText={{ label: 'Test Runs' }}
                    category="utility"
                    name="list"
                    size="small"
                  />
                }
              >
                {!tests?.runs?.length ? (
                  <div className="slds-p-horizontal_medium slds-p-bottom_small slds-text-body_regular slds-text-color_weak">
                    No test runs found. Run <code>sfdt test</code> to generate results.
                  </div>
                ) : (
                  <table
                    className="slds-table slds-table_cell-buffer slds-table_bordered slds-table_striped slds-no-row-hover"
                    style={{ width: '100%' }}
                  >
                    <thead>
                      <tr className="slds-line-height_reset">
                        <th scope="col"><div className="slds-truncate">Date</div></th>
                        <th scope="col" className="slds-text-align_right"><div className="slds-truncate">Passed</div></th>
                        <th scope="col" className="slds-text-align_right"><div className="slds-truncate">Failed</div></th>
                        <th scope="col" className="slds-text-align_right"><div className="slds-truncate">Status</div></th>
                      </tr>
                    </thead>
                    <tbody>
                      {tests.runs.slice(0, 5).map((run, i) => (
                        <tr key={i} className="slds-hint-parent">
                          <td className="slds-text-body_small">{new Date(run.date).toLocaleDateString()}</td>
                          <td className="slds-text-align_right slds-text-body_small" style={{ color: '#2e844a', fontWeight: 600 }}>
                            {run.passed ?? 0}
                          </td>
                          <td className="slds-text-align_right slds-text-body_small" style={{ color: run.failed ? '#ba0517' : undefined, fontWeight: run.failed ? 700 : undefined }}>
                            {run.failed ?? 0}
                          </td>
                          <td className="slds-text-align_right">
                            <StatusBadge status={run.failed ? 'fail' : 'pass'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </div>

            {/* Preflight + Drift stacked */}
            <div className="slds-col slds-size_1-of-1 slds-medium-size_1-of-2">
              <div className="slds-grid slds-wrap slds-gutters_direct">

                <div className="slds-col slds-size_1-of-1 slds-m-bottom_small">
                  <Card
                    heading="Last Preflight Check"
                    icon={
                      <Icon
                        assistiveText={{ label: 'Preflight' }}
                        category="utility"
                        name="check"
                        size="small"
                      />
                    }
                  >
                    {!preflight?.checks?.length ? (
                      <div className="slds-p-horizontal_medium slds-p-bottom_small slds-text-body_regular slds-text-color_weak">
                        No preflight data. Run <code>sfdt preflight</code>.
                      </div>
                    ) : (
                      <>
                        <div className="slds-p-horizontal_medium slds-p-bottom_small slds-text-body_small slds-text-color_weak slds-m-bottom_xx-small">
                          {preflight.date ? new Date(preflight.date).toLocaleString() : ''}
                        </div>
                        {preflight.checks.slice(0, 4).map((c, i) => (
                          <div
                            key={i}
                            className="slds-grid slds-grid_align-spread slds-grid_vertical-align-center slds-p-horizontal_medium slds-p-vertical_x-small slds-border_bottom"
                          >
                            <span className="slds-text-body_small">{c.name}</span>
                            <StatusBadge status={c.status} />
                          </div>
                        ))}
                      </>
                    )}
                  </Card>
                </div>

                <div className="slds-col slds-size_1-of-1">
                  <Card
                    heading="Drift Status"
                    icon={
                      <Icon
                        assistiveText={{ label: 'Drift' }}
                        category="utility"
                        name="refresh"
                        size="small"
                      />
                    }
                  >
                    {!drift?.result ? (
                      <div className="slds-p-horizontal_medium slds-p-bottom_small slds-text-body_regular slds-text-color_weak">
                        No drift data. Run <code>sfdt drift</code>.
                      </div>
                    ) : (
                      <div className="slds-p-horizontal_medium slds-p-bottom_small slds-grid slds-grid_vertical-align-center slds-wrap slds-gutters_direct">
                        <StatusBadge status={drift.result} />
                        {drift.date && (
                          <span className="slds-text-body_small slds-text-color_weak slds-m-left_small">
                            {new Date(drift.date).toLocaleString()}
                          </span>
                        )}
                        {drift.count !== undefined && (
                          <span className="slds-text-body_small slds-text-color_weak slds-m-left_small">
                            {drift.count} component{drift.count !== 1 ? 's' : ''} differ
                          </span>
                        )}
                      </div>
                    )}
                  </Card>
                </div>

              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
