import React from 'react';

const VARIANTS = {
  pass: { bg: '#2e844a', color: '#fff', label: 'Pass' },
  passed: { bg: '#2e844a', color: '#fff', label: 'Passed' },
  success: { bg: '#2e844a', color: '#fff', label: 'Success' },
  fail: { bg: '#ba0517', color: '#fff', label: 'Fail' },
  failed: { bg: '#ba0517', color: '#fff', label: 'Failed' },
  error: { bg: '#ba0517', color: '#fff', label: 'Error' },
  warn: { bg: '#dd7a01', color: '#fff', label: 'Warning' },
  warning: { bg: '#dd7a01', color: '#fff', label: 'Warning' },
  running: { bg: '#0176d3', color: '#fff', label: 'Running' },
  unknown: { bg: '#919191', color: '#fff', label: 'Unknown' },
  clean: { bg: '#2e844a', color: '#fff', label: 'Clean' },
  drift: { bg: '#dd7a01', color: '#fff', label: 'Drift' },
};

export default function StatusBadge({ status }) {
  const key = (status ?? 'unknown').toLowerCase();
  const variant = VARIANTS[key] ?? VARIANTS.unknown;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: '12px',
        fontSize: '12px',
        fontWeight: 600,
        background: variant.bg,
        color: variant.color,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}
    >
      {variant.label}
    </span>
  );
}
