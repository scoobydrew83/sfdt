function Sparkline({ values }) {
  if (!values || values.length < 2) return null;

  const w = 60;
  const h = 24;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;

  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - ((v - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  return (
    <svg
      className="stat-sparkline"
      width={w}
      height={h}
      viewBox="-1 -2 62 27"
      aria-hidden="true"
    >
      <polyline
        points={pts}
        fill="none"
        stroke="var(--stat-accent, var(--brand-500))"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function StatCard({
  label,
  value,
  sub,
  accent = 'brand',
  sparkline,
  trend,
  trendColor = 'muted',
  valueColor,
}) {
  const hasFooter = sparkline || trend;

  return (
    <div className={`stat-card accent-${accent}`}>
      <div className="stat-kicker">{label}</div>
      <div className={`stat-value${valueColor ? ` stat-value-${valueColor}` : ''}`}>
        {value ?? '—'}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
      {hasFooter && (
        <div className="stat-footer">
          {trend && (
            <span className={`stat-trend stat-trend-${trendColor}`}>{trend}</span>
          )}
          {sparkline && <Sparkline values={sparkline} />}
        </div>
      )}
    </div>
  );
}
