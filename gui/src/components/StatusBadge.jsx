import React from 'react';
import Badge from '@salesforce/design-system-react/components/badge';

const CONFIG = {
  pass:          { color: 'success', label: 'Pass' },
  passed:        { color: 'success', label: 'Passed' },
  success:       { color: 'success', label: 'Success' },
  fail:          { color: 'error',   label: 'Fail' },
  failed:        { color: 'error',   label: 'Failed' },
  error:         { color: 'error',   label: 'Error' },
  warn:          { color: 'warning', label: 'Warning' },
  warning:       { color: 'warning', label: 'Warning' },
  running:       { color: 'default', label: 'Running' },
  unknown:       { color: 'inverse', label: 'Unknown' },
  clean:         { color: 'success', label: 'Clean' },
  drift:         { color: 'warning', label: 'Drift' },
  // Compare statuses
  'source-only': { color: 'warning', label: 'Only in Source' },
  'target-only': { color: 'error',   label: 'Only in Target' },
  both:          { color: 'default', label: 'Checking…' },
  modified:      { color: 'warning', label: 'Modified' },
  identical:     { color: 'success', label: 'Identical' },
};

export default function StatusBadge({ status }) {
  const key = (status ?? 'unknown').toLowerCase();
  const { color, label } = CONFIG[key] ?? CONFIG.unknown;
  return <Badge content={label} color={color} />;
}
