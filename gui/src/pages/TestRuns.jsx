import React, { useState, useEffect } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Icon from '@salesforce/design-system-react/components/icon';
import Card from '@salesforce/design-system-react/components/card';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Spinner from '@salesforce/design-system-react/components/spinner';
import Alert from '@salesforce/design-system-react/components/alert';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

const StatusCell = ({ item }) => <StatusBadge status={item.status} />;
StatusCell.displayName = DataTableCell.displayName;

const CoverageCell = ({ item }) => {
  const pct = item.coverage;
  if (pct === undefined || pct === null) {
    return <span className="slds-text-color_weak">—</span>;
  }
  const color = pct >= 75 ? '#2e844a' : pct >= 60 ? '#dd7a01' : '#ba0517';
  return <span style={{ fontWeight: 700, color }}>{pct}%</span>;
};
CoverageCell.displayName = DataTableCell.displayName;

export default function TestRuns() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.testRuns()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const rows = (data?.runs ?? []).map((r, i) => ({
    id:       String(i),
    date:     r.date ? new Date(r.date).toLocaleString() : '—',
    passed:   r.passed ?? 0,
    failed:   r.failed ?? 0,
    errors:   r.errors ?? 0,
    coverage: r.coverage,
    duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '—',
    status:   r.failed || r.errors ? 'fail' : 'pass',
  }));

  return (
    <div>
      <PageHeader
        title="Test Runs"
        label="SFDT"
        info="History of Apex test executions from sfdt test"
        variant="object-home"
        icon={
          <Icon
            assistiveText={{ label: 'Test Runs' }}
            category="utility"
            name="list"
            size="large"
          />
        }
      />

      <div className="slds-p-around_large">
        {loading && (
          <div style={{ position: 'relative', height: '200px' }}>
            <Spinner size="large" variant="brand" />
          </div>
        )}

        {error && (
          <Alert
            labels={{ heading: `Failed to load test results: ${error}` }}
            variant="error"
            className="slds-m-bottom_medium"
          />
        )}

        {!loading && !error && rows.length === 0 && (
          <EmptyState
            title="No test runs found"
            message="Run sfdt test to generate results that will appear here."
          />
        )}

        {!loading && !error && rows.length > 0 && (
          <Card
            heading="Test History"
            icon={
              <Icon
                assistiveText={{ label: 'Test History' }}
                category="utility"
                name="list"
                size="small"
              />
            }
          >
            <DataTable items={rows} id="test-runs-table" striped>
              <DataTableColumn label="Date"     property="date" />
              <DataTableColumn label="Passed"   property="passed" />
              <DataTableColumn label="Failed"   property="failed" />
              <DataTableColumn label="Errors"   property="errors" />
              <DataTableColumn label="Coverage" property="coverage">
                <CoverageCell />
              </DataTableColumn>
              <DataTableColumn label="Duration" property="duration" />
              <DataTableColumn label="Status"   property="status">
                <StatusCell />
              </DataTableColumn>
            </DataTable>
          </Card>
        )}

        {data?.summary && (
          <Card className="slds-m-top_medium" heading="Summary">
            <div className="slds-card__body_inner slds-text-body_regular slds-text-color_weak">
              {data.summary}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
