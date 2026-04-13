import React from 'react';

export default function StatCard({ label, value, sub, accent }) {
  return (
    <div
      className="slds-box slds-box_small"
      style={{
        background: '#fff',
        borderRadius: '8px',
        padding: '20px 24px',
        flex: 1,
        minWidth: '150px',
        borderTop: `4px solid ${accent ?? '#0176d3'}`,
        boxShadow: '0 1px 3px rgba(0,0,0,0.08)',
      }}
    >
      <div
        style={{
          fontSize: '12px',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          color: '#706e6b',
          marginBottom: '8px',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: '36px',
          fontWeight: 700,
          color: '#181818',
          lineHeight: 1,
          marginBottom: '4px',
        }}
      >
        {value ?? '—'}
      </div>
      {sub && (
        <div style={{ fontSize: '12px', color: '#706e6b', marginTop: '4px' }}>{sub}</div>
      )}
    </div>
  );
}
