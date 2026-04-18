const CONFIG = {
  pass:          { cls: 'badge-success',  label: 'Pass' },
  passed:        { cls: 'badge-success',  label: 'Passed' },
  success:       { cls: 'badge-success',  label: 'Success' },
  clean:         { cls: 'badge-success',  label: 'Clean' },
  identical:     { cls: 'badge-identical',label: 'Identical' },
  fail:          { cls: 'badge-error',    label: 'Fail' },
  failed:        { cls: 'badge-error',    label: 'Failed' },
  error:         { cls: 'badge-error',    label: 'Error' },
  conflict:      { cls: 'badge-conflict', label: 'Conflict' },
  warn:          { cls: 'badge-warning',  label: 'Warning' },
  warning:       { cls: 'badge-warning',  label: 'Warning' },
  drift:         { cls: 'badge-warning',  label: 'Drift' },
  modified:      { cls: 'badge-modified', label: 'Modified' },
  'source-only': { cls: 'badge-modified', label: 'Source only' },
  'target-only': { cls: 'badge-conflict', label: 'Target only' },
  both:          { cls: 'badge-neutral',  label: 'Checking…' },
  running:       { cls: 'badge-neutral',  label: 'Running' },
  source:        { cls: 'badge-source',   label: 'Source' },
  target:        { cls: 'badge-target',   label: 'Target' },
  unknown:       { cls: 'badge-neutral',  label: 'Unknown' },
};

export default function StatusBadge({ status, showDot = true }) {
  const key = (status ?? 'unknown').toLowerCase();
  const { cls, label } = CONFIG[key] ?? CONFIG.unknown;
  return (
    <span className={`badge ${cls}`}>
      {showDot && <span className="badge-dot" />}
      {label}
    </span>
  );
}
