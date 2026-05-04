import { useState, useEffect, useContext } from 'react';
import { api } from '../api.js';
import StatCard from '../components/StatCard.jsx';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';
import { IconCheckCircle, IconXCircle, IconAlertTri } from '../Icons.jsx';
import { ChatContext } from '../App.jsx';

function subtaskState(status) {
  const s = (status ?? '').toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'success') return 'done';
  if (s === 'fail' || s === 'failed' || s === 'error') return 'fail';
  if (s === 'warn' || s === 'warning') return 'active';
  return 'pending';
}

function SubtaskIcon({ status }) {
  const s = (status ?? '').toLowerCase();
  if (s === 'pass' || s === 'passed' || s === 'success')
    return <IconCheckCircle size={14} />;
  if (s === 'fail' || s === 'failed' || s === 'error')
    return <IconXCircle size={14} />;
  if (s === 'warn' || s === 'warning')
    return <IconAlertTri size={14} />;
  return <span style={{ fontSize: 12, lineHeight: 1 }}>—</span>;
}

const MAX_MISSING_SHOWN = 5;

function DependencyCheckSection() {
  const [depState, setDepState] = useState('idle'); // idle | loading | done | error
  const [depResult, setDepResult] = useState(null);
  const [depError, setDepError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setDepState('loading');
      try {
        // Resolve org from project info
        const projectInfo = await api.project();
        const org = projectInfo?.org;
        if (!org) {
          if (!cancelled) {
            setDepError('No default org configured');
            setDepState('error');
          }
          return;
        }

        // Resolve manifest: use the first available manifest
        const manifestsData = await api.listManifests();
        const manifests = manifestsData?.manifests ?? [];
        if (manifests.length === 0) {
          if (!cancelled) {
            setDepError('No manifests found');
            setDepState('error');
          }
          return;
        }

        const manifestRelPath = manifests[0].relPath;
        const result = await api.dependenciesPreflight(manifestRelPath, org);

        if (!cancelled) {
          setDepResult(result);
          setDepState('done');
        }
      } catch (err) {
        if (!cancelled) {
          setDepError(err.message ?? 'Unknown error');
          setDepState('error');
        }
      }
    }

    run();
    return () => { cancelled = true; };
  }, []);

  const rows = [];

  if (depState === 'loading') {
    rows.push(
      <div key="loading" className="subtask pending">
        <span className="s-icon"><span style={{ fontSize: 12, lineHeight: 1 }}>—</span></span>
        <span className="s-name">Checking dependencies…</span>
      </div>
    );
  } else if (depState === 'error') {
    rows.push(
      <div key="error" className="subtask fail">
        <span className="s-icon"><IconXCircle size={14} /></span>
        <span className="s-name">Dependency check failed: {depError}</span>
      </div>
    );
  } else if (depState === 'done' && depResult) {
    const { status, missing = [], warnings = [] } = depResult;

    if (status === 'pass') {
      rows.push(
        <div key="pass" className="subtask done">
          <span className="s-icon"><IconCheckCircle size={14} /></span>
          <span className="s-name">All dependencies satisfied</span>
        </div>
      );
    } else if (status === 'warn') {
      rows.push(
        <div key="warn" className="subtask active">
          <span className="s-icon"><IconAlertTri size={14} /></span>
          <span className="s-name">
            Standard type dependencies detected ({warnings.length} warning{warnings.length !== 1 ? 's' : ''})
          </span>
        </div>
      );
    } else if (status === 'fail') {
      const shown = missing.slice(0, MAX_MISSING_SHOWN);
      const overflow = missing.length - shown.length;
      shown.forEach((item, i) => {
        const referencedBy = item.referencedBy?.[0];
        rows.push(
          <div key={i} className="subtask fail">
            <span className="s-icon"><IconXCircle size={14} /></span>
            <span className="s-name">
              {item.name} ({item.type}){referencedBy ? ` — referenced by ${referencedBy}` : ''}
            </span>
          </div>
        );
      });
      if (overflow > 0) {
        rows.push(
          <div key="overflow" className="subtask fail">
            <span className="s-icon"><span style={{ fontSize: 12, lineHeight: 1 }}>—</span></span>
            <span className="s-name" style={{ fontStyle: 'italic' }}>… and {overflow} more</span>
          </div>
        );
      }
    }
  }

  return (
    <div className="card" style={{ marginTop: '16px' }}>
      <div className="card-head">
        <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0, color: 'var(--fg-muted)' }}>
            <path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          Dependency Check
        </div>
      </div>
      <div>{rows}</div>
    </div>
  );
}

export default function PreflightPage() {
  const [data, setData]             = useState(null);
  const [loading, setLoading]       = useState(true);
  const [refreshKey, setRefreshKey] = useState(0);
  const chat = useContext(ChatContext);

  useEffect(() => {
    setLoading(true);
    api.preflight()
      .then((result) => {
        setData(result);
        if (result) {
          chat?.setPageContext({
            page: 'Preflight',
            data: {
              checks: (result.checks ?? []).map((c) => ({
                name: c.name,
                status: c.status,
                message: c.message,
              })),
            },
          });
        }
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [refreshKey, chat]);

  const checks      = data?.checks ?? [];
  const passCount   = checks.filter((c) => ['pass','passed','success'].includes(c.status?.toLowerCase())).length;
  const failCount   = checks.filter((c) => ['fail','failed','error'].includes(c.status?.toLowerCase())).length;
  const warnCount   = checks.filter((c) => ['warn','warning'].includes(c.status?.toLowerCase())).length;
  const overallStatus = data?.status;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Preflight</h1>
          <p className="page-subtitle">
            {data?.date ? `Last run ${new Date(data.date).toLocaleString()}` : 'Pre-deployment readiness checks'}
          </p>
        </div>
        {overallStatus && (
          <div className="page-header-actions">
            <StatusBadge status={overallStatus} />
          </div>
        )}
      </div>

      <CommandRunner command="preflight" label="Preflight Check" onComplete={() => setRefreshKey((k) => k + 1)} />

      {checks.length > 0 && (
        <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <StatCard label="Passed" value={passCount} accent="green" />
          <StatCard label="Failed" value={failCount} accent={failCount > 0 ? 'red' : 'green'} />
          <StatCard label="Warnings" value={warnCount} accent={warnCount > 0 ? 'amber' : 'brand'} />
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && checks.length === 0 && (
        <EmptyState
          title="No preflight data"
          message="Run sfdt preflight to generate a report."
        />
      )}

      {!loading && checks.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="card-title">{checks.length} Check{checks.length !== 1 ? 's' : ''}</div>
            {failCount > 0 && chat && (
              <button
                onClick={() => chat?.openChat('My preflight checks have failures. Can you explain what each failing check means and how to resolve it?')}
                style={{
                  fontSize: '12px',
                  padding: '4px 10px',
                  borderRadius: '6px',
                  border: '1px solid var(--brand-300, #a5b4fc)',
                  background: 'var(--brand-50, #eef2ff)',
                  color: 'var(--brand-700, #4338ca)',
                  cursor: 'pointer',
                  marginLeft: '8px',
                }}
              >
                ✦ Ask AI about failures
              </button>
            )}
          </div>
          <div>
            {checks.map((c, i) => {
              const state = subtaskState(c.status);
              return (
                <div key={i} className={`subtask ${state}`}>
                  <span className="s-icon">
                    <SubtaskIcon status={c.status} />
                  </span>
                  <span className="s-name">{c.name}</span>
                  {c.message && (
                    <span className="s-time">{c.message}</span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!loading && checks.length > 0 && <DependencyCheckSection />}
    </div>
  );
}
