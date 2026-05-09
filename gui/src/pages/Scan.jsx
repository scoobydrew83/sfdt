import { useState, useEffect } from 'react';
import { api } from '../api.js';
import EmptyState from '../components/EmptyState.jsx';
import StatCard from '../components/StatCard.jsx';

function formatRelativeTime(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d)) return null;
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.round(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 1) return `${diffHr}h ago`;
  return `${diffDay}d ago`;
}

export default function ScanPage() {
  const [orgs, setOrgs]                   = useState([]);
  const [selectedOrg, setSelectedOrg]     = useState('');
  const [scanData, setScanData]           = useState(null);
  const [running, setRunning]             = useState(false);
  const [error, setError]                 = useState(null);
  const [selectedType, setSelectedType]   = useState(null);
  const [memberSearch, setMemberSearch]   = useState('');

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setSelectedOrg(list[0].alias);
      })
      .catch(() => {});
    api.scan()
      .then((data) => {
        if (data) {
          setScanData(data);
          const types = Object.keys(data.inventory).sort();
          if (types.length) setSelectedType(types[0]);
        }
      })
      .catch(() => {});
  }, []);

  const sortedTypes = scanData
    ? Object.entries(scanData.inventory).sort(([a], [b]) => a.localeCompare(b))
    : [];

  const currentMembers = scanData && selectedType
    ? (scanData.inventory[selectedType] ?? [])
    : [];

  const filteredMembers = memberSearch
    ? currentMembers.filter((m) => m.toLowerCase().includes(memberSearch.toLowerCase()))
    : currentMembers;

  const handleRunScan = async () => {
    if (!selectedOrg) return;
    setError(null);
    setRunning(true);
    try {
      const data = await api.runScan(selectedOrg);
      setScanData(data);
      const types = Object.keys(data.inventory).sort();
      setSelectedType(types.length ? types[0] : null);
      setMemberSearch('');
    } catch (err) {
      setError(err.message ?? 'Scan failed');
    } finally {
      setRunning(false);
    }
  };

  const subtitle = scanData
    ? `${scanData.org} · ${formatRelativeTime(scanData.timestamp)}`
    : 'No scan yet';

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="page-header-text">
          <h1>Scan</h1>
          <p className="page-subtitle">{subtitle}</p>
        </div>
      </div>

      {/* Org selector card */}
      <div className="card mb-4">
        <div className="card-head">
          <div className="card-title">Run Scan</div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <div className="input-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="input-label">Org</label>
              <select
                className="input"
                value={selectedOrg}
                onChange={(e) => setSelectedOrg(e.target.value)}
              >
                <option value="">Select org…</option>
                {orgs.map((o) => (
                  <option key={o.alias} value={o.alias}>{o.alias}</option>
                ))}
              </select>
            </div>
            <button
              className="btn btn-primary"
              disabled={!selectedOrg || running}
              onClick={handleRunScan}
              style={{ flexShrink: 0 }}
            >
              {running ? 'Scanning…' : 'Run Scan'}
            </button>
          </div>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="alert alert-error mb-4">
          <span>{error}</span>
        </div>
      )}

      {/* Spinner while running */}
      {running && (
        <div className="spinner-center"><div className="spinner spinner-lg" /></div>
      )}

      {/* Empty state */}
      {!running && !scanData && (
        <EmptyState
          title="No scan yet"
          message="Run `sfdt scan` or click Run Scan above."
        />
      )}

      {/* Results */}
      {!running && scanData && (
        <>
          {/* Stats row — 3 cards */}
          <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <StatCard label="Types"   value={scanData.summary.totalTypes}   accent="brand" />
            <StatCard label="Members" value={scanData.summary.totalMembers} accent="brand" />
            <StatCard
              label="Last Scan"
              value={scanData.org}
              sub={formatRelativeTime(scanData.timestamp)}
              accent="green"
            />
          </div>

          {/* Two-panel inventory */}
          <div className="card" style={{ marginTop: 'var(--s-4)' }}>
            <div className="card-body" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '280px 1fr', height: 500 }}>

                {/* Left panel: metadata type list */}
                <div style={{ borderRight: '1px solid var(--border-subtle)', overflowY: 'auto' }}>
                  {sortedTypes.map(([type, members]) => (
                    <button
                      key={type}
                      className={`nav-item${selectedType === type ? ' active' : ''}`}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        padding: 'var(--s-2) var(--s-3)',
                        borderRadius: 0,
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        color: 'var(--fg-default)',
                      }}
                      onClick={() => { setSelectedType(type); setMemberSearch(''); }}
                    >
                      <span style={{ fontSize: 'var(--fs-sm)' }}>{type}</span>
                      <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
                        {members.length}
                      </span>
                    </button>
                  ))}
                </div>

                {/* Right panel: member grid */}
                <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  <div style={{ padding: 'var(--s-3)', borderBottom: '1px solid var(--border-subtle)' }}>
                    <input
                      className="input"
                      style={{ width: '100%' }}
                      placeholder="Search members…"
                      value={memberSearch}
                      onChange={(e) => setMemberSearch(e.target.value)}
                    />
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1, padding: 'var(--s-3)' }}>
                    {selectedType && filteredMembers.length > 0 && (
                      <div className="three-col" style={{ gap: 'var(--s-2)' }}>
                        {filteredMembers.map((member) => (
                          <div
                            key={member}
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 'var(--fs-xs)',
                              padding: 'var(--s-1) var(--s-2)',
                              background: 'var(--bg-subtle)',
                              borderRadius: 'var(--r-sm)',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                            title={member}
                          >
                            {member}
                          </div>
                        ))}
                      </div>
                    )}
                    {selectedType && filteredMembers.length === 0 && (
                      <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>No members match.</p>
                    )}
                    {!selectedType && (
                      <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>Select a type to view members.</p>
                    )}
                  </div>
                </div>

              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
