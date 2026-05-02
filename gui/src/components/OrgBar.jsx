export default function OrgBar({ source, target, lastScanned }) {
  return (
    <div className="org-bar">
      <div className="org-pill">
        <span className="org-dot" aria-hidden="true" />
        <span className="org-alias">{source}</span>
      </div>
      <span className="org-arrow" aria-hidden="true">→</span>
      <div className="org-pill">
        <span className="org-dot stg" aria-hidden="true" />
        <span className="org-alias">{target}</span>
      </div>
      {lastScanned && (
        <span className="org-meta">Last scanned {lastScanned}</span>
      )}
    </div>
  );
}
