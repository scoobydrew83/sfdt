import React from 'react';

export default function EmptyState({ title, message }) {
  return (
    <div
      style={{
        textAlign: 'center',
        padding: '60px 32px',
        color: '#706e6b',
      }}
    >
      <div style={{ fontSize: '48px', marginBottom: '16px' }}>📭</div>
      <div style={{ fontSize: '16px', fontWeight: 600, color: '#3e3e3c', marginBottom: '8px' }}>
        {title ?? 'No data yet'}
      </div>
      <div style={{ fontSize: '14px' }}>{message ?? 'Run a command to see results here.'}</div>
    </div>
  );
}
