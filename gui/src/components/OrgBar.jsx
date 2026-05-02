export default function OrgBar({
  source,
  target,
  lastScanned,
  sourceStatus = 'prod',
  targetStatus = 'stg',
}) {
  return (
    <div className="org-bar">
      <div className="org-pill">
        <span
          className={`org-dot${sourceStatus === 'stg' ? ' stg' : ''}`}
          aria-hidden="true"
        />
        <span className="org-alias">{source}</span>
      </div>
      <span className="org-arrow" aria-hidden="true">→</span>
      <div className="org-pill">
        <span
          className={`org-dot${targetStatus === 'stg' ? ' stg' : ''}`}
          aria-hidden="true"
        />
        <span className="org-alias">{target}</span>
      </div>
      {lastScanned && (
        <span className="org-meta">Last scanned {lastScanned}</span>
      )}
    </div>
  );
}
