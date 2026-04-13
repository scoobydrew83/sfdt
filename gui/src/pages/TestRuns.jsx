import React, { useState, useEffect } from 'react';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

const StatusCell = ({ item }) => <StatusBadge status={item.status} />;
StatusCell.displayName = DataTableCell.displayName;

const CoverageCell = ({ item }) => {
  const pct = item.coverage;
  if (pct === undefined || pct === null) return <span style={{ color: '#919191' }}>—</span>;
  const color = pct >= 75 ? '#2e844a' : pct >= 60 ? '#dd7a01' : '#ba0517';
  return <span style={{ fontWeight: 700, color }}>{pct}%</span>;
};
CoverageCell.displayName = DataTableCell.displayName;

export default function TestRuns() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .testRuns()
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const rows = (data?.runs ?? []).map((r, i) => ({
    id: String(i),
    date: r.date ? new Date(r.date).toLocaleString() : '—',
    passed: r.passed ?? 0,
    failed: r.failed ?? 0,
    errors: r.errors ?? 0,
    coverage: r.coverage,
    duration: r.duration ? `${(r.duration / 1000).toFixed(1)}s` : '—',
    status: r.failed || r.errors ? 'fail' : 'pass',
  }));

  return (
    <div style={{ padding: '28px 32px' }}>
      <div style={{ marginBottom: '28px' }}>
        <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#032d60', margin: 0 }}>
          Test Runs
        </h1>
        <p style={{ fontSize: '14px', color: '#706e6b', marginTop: '4px' }}>
          History of Apex test executions from <code>sfdt test</code>
        </p>
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <Spinner size="large" variant="brand" />
        </div>
      )}

      {error && (
        <div
          className="slds-notify slds-notify_alert slds-alert_error"
          role="alert"
          style={{ marginBottom: '20px' }}
        >
          <span className="slds-assistive-text">Error</span>
          <h2>Failed to load test results: {error}</h2>
        </div>
      )}

      {!loading && !error && rows.length === 0 && (
        <EmptyState
          title="No test runs found"
          message="Run sfdt test to generate results that will appear here."
        />
      )}

      {!loading && !error && rows.length > 0 && (
        <div
          style={{
            background: '#fff',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}
        >
          <DataTable items={rows} id="test-runs-table" striped>
            <DataTableColumn label="Date" property="date" />
            <DataTableColumn label="Passed" property="passed" />
            <DataTableColumn label="Failed" property="failed" />
            <DataTableColumn label="Errors" property="errors" />
            <DataTableColumn label="Coverage" property="coverage">
              <CoverageCell />
            </DataTableColumn>
            <DataTableColumn label="Duration" property="duration" />
            <DataTableColumn label="Status" property="status">
              <StatusCell />
            </DataTableColumn>
          </DataTable>
        </div>
      )}

      {data?.summary && (
        <div
          style={{
            marginTop: '20px',
            padding: '16px 20px',
            background: '#fff',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            fontSize: '13px',
            color: '#706e6b',
          }}
        >
          <strong style={{ color: '#3e3e3c' }}>Summary:</strong> {data.summary}
        </div>
      )}
    </div>
  );
}
