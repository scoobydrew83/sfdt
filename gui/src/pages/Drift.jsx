import React, { useState, useEffect } from 'react';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

const DriftStatusCell = ({ item }) => <StatusBadge status={item.drift} />;
DriftStatusCell.displayName = DataTableCell.displayName;

export default function DriftPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    api
      .drift()
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  const components = data?.components ?? [];
  const filtered =
    filter === 'all'
      ? components
      : components.filter((c) => c.drift?.toLowerCase() === filter);

  const rows = filtered.map((c, i) => ({
    id: String(i),
    name: c.name ?? '—',
    type: c.type ?? '—',
    drift: c.drift ?? 'unknown',
  }));

  const driftCount = components.filter(
    (c) => c.drift?.toLowerCase() === 'drift',
  ).length;
  const cleanCount = components.filter(
    (c) => c.drift?.toLowerCase() === 'clean',
  ).length;

  return (
    <div style={{ padding: '28px 32px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          marginBottom: '28px',
        }}
      >
        <div>
          <h1 style={{ fontSize: '24px', fontWeight: 700, color: '#032d60', margin: 0 }}>
            Drift Detection
          </h1>
          <p style={{ fontSize: '14px', color: '#706e6b', marginTop: '4px' }}>
            Metadata drift between local source and target org
          </p>
        </div>
        {data?.date && (
          <div style={{ fontSize: '13px', color: '#706e6b' }}>
            Last checked: {new Date(data.date).toLocaleString()}
          </div>
        )}
      </div>

      {/* Stats row */}
      {components.length > 0 && (
        <div
          style={{ display: 'flex', gap: '12px', marginBottom: '24px', flexWrap: 'wrap' }}
        >
          {[
            {
              id: 'all',
              label: 'All',
              count: components.length,
              accent: '#0176d3',
            },
            { id: 'clean', label: 'Clean', count: cleanCount, accent: '#2e844a' },
            { id: 'drift', label: 'Drift', count: driftCount, accent: '#dd7a01' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setFilter(tab.id)}
              style={{
                padding: '8px 20px',
                borderRadius: '20px',
                border: `2px solid ${filter === tab.id ? tab.accent : '#e5e5e5'}`,
                background: filter === tab.id ? tab.accent : '#fff',
                color: filter === tab.id ? '#fff' : '#3e3e3c',
                fontWeight: 600,
                fontSize: '13px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                transition: 'all 0.15s',
              }}
            >
              {tab.label}
              <span
                style={{
                  fontSize: '12px',
                  background: filter === tab.id ? 'rgba(255,255,255,0.25)' : '#f3f3f3',
                  padding: '1px 7px',
                  borderRadius: '10px',
                }}
              >
                {tab.count}
              </span>
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <Spinner size="large" variant="brand" />
        </div>
      )}

      {!loading && components.length === 0 && (
        <EmptyState
          title="No drift data"
          message="Run sfdt drift to compare your local source against the target org."
        />
      )}

      {!loading && components.length > 0 && (
        <div
          style={{
            background: '#fff',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}
        >
          {rows.length === 0 ? (
            <div style={{ padding: '32px', textAlign: 'center', color: '#706e6b', fontSize: '14px' }}>
              No components match the selected filter.
            </div>
          ) : (
            <DataTable items={rows} id="drift-table" striped>
              <DataTableColumn label="Component" property="name" />
              <DataTableColumn label="Type" property="type" />
              <DataTableColumn label="Drift" property="drift">
                <DriftStatusCell />
              </DataTableColumn>
            </DataTable>
          )}
        </div>
      )}
    </div>
  );
}
