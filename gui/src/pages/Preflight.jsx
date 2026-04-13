import React, { useState, useEffect } from 'react';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

function CheckRow({ check }) {
  const icon =
    check.status === 'pass' || check.status === 'success'
      ? '✓'
      : check.status === 'fail' || check.status === 'error'
        ? '✗'
        : '⚠';
  const iconColor =
    check.status === 'pass' || check.status === 'success'
      ? '#2e844a'
      : check.status === 'fail' || check.status === 'error'
        ? '#ba0517'
        : '#dd7a01';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: '12px',
        padding: '12px 20px',
        borderBottom: '1px solid #f3f3f3',
      }}
    >
      <span style={{ fontSize: '18px', color: iconColor, flexShrink: 0, marginTop: '1px' }}>
        {icon}
      </span>
      <div style={{ flex: 1 }}>
        <div
          style={{ fontSize: '14px', fontWeight: 600, color: '#3e3e3c', marginBottom: '2px' }}
        >
          {check.name}
        </div>
        {check.message && (
          <div style={{ fontSize: '13px', color: '#706e6b' }}>{check.message}</div>
        )}
      </div>
      <StatusBadge status={check.status} />
    </div>
  );
}

export default function PreflightPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .preflight()
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  const overallStatus = data?.status;
  const checks = data?.checks ?? [];

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
            Preflight Check
          </h1>
          <p style={{ fontSize: '14px', color: '#706e6b', marginTop: '4px' }}>
            Results of the last <code>sfdt preflight</code> run
          </p>
        </div>
        {overallStatus && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <StatusBadge status={overallStatus} />
            {data?.date && (
              <span style={{ fontSize: '13px', color: '#706e6b' }}>
                {new Date(data.date).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      {loading && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '60px' }}>
          <Spinner size="large" variant="brand" />
        </div>
      )}

      {!loading && checks.length === 0 && (
        <EmptyState
          title="No preflight data"
          message="Run sfdt preflight to generate a report that will appear here."
        />
      )}

      {!loading && checks.length > 0 && (
        <div
          style={{
            background: '#fff',
            borderRadius: '8px',
            boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          <div
            style={{
              padding: '16px 20px',
              borderBottom: '1px solid #e5e5e5',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            }}
          >
            <span style={{ fontSize: '14px', fontWeight: 700, color: '#3e3e3c' }}>
              {checks.length} check{checks.length !== 1 ? 's' : ''}
            </span>
            {checks.filter((c) => c.status === 'pass').length > 0 && (
              <span
                style={{
                  fontSize: '12px',
                  color: '#2e844a',
                  background: '#f3fbf5',
                  padding: '2px 8px',
                  borderRadius: '10px',
                }}
              >
                {checks.filter((c) => c.status === 'pass' || c.status === 'success').length} passed
              </span>
            )}
            {checks.filter((c) => c.status === 'fail' || c.status === 'error').length > 0 && (
              <span
                style={{
                  fontSize: '12px',
                  color: '#ba0517',
                  background: '#fef1ee',
                  padding: '2px 8px',
                  borderRadius: '10px',
                }}
              >
                {checks.filter((c) => c.status === 'fail' || c.status === 'error').length} failed
              </span>
            )}
          </div>
          {checks.map((c, i) => (
            <CheckRow key={i} check={c} />
          ))}
        </div>
      )}
    </div>
  );
}
