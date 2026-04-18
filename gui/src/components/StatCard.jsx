export default function StatCard({ label, value, sub, accent = 'brand' }) {
  return (
    <div className={`stat-card accent-${accent}`}>
      <div className="stat-kicker">{label}</div>
      <div className="stat-value">{value ?? '—'}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}
