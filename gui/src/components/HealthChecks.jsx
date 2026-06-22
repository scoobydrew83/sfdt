import { useState, useEffect, useContext, useCallback } from 'react';
import { api } from '../api.js';
import StatCard from './StatCard.jsx';
import StatusBadge from './StatusBadge.jsx';
import EmptyState from './EmptyState.jsx';
import { IconCheckCircle, IconXCircle, IconAlertTri } from '../Icons.jsx';
import { ChatContext } from '../App.jsx';

function CheckIcon({ status }) {
  if (status === 'ok') return <IconCheckCircle size={14} />;
  if (status === 'fail' || status === 'error') return <IconXCircle size={14} />;
  if (status === 'warn') return <IconAlertTri size={14} />;
  return <span style={{ fontSize: 12, lineHeight: 1 }}>—</span>;
}

function describeFinding(f) {
  if (f.name && f.apiVersion != null) return `${f.type ? `${f.type} ` : ''}${f.name} (API ${f.apiVersion})`;
  if (f.username) return `${f.name ?? f.username} <${f.username}>${f.lastLogin ? ` — last login ${f.lastLogin}` : ''}`;
  if (f.action) return `${f.date}: ${f.action} (${f.section}) by ${f.user}`;
  if (f.job) return `${f.date}: ${f.job} (${f.type}) — ${f.errors} error(s)`;
  // Licenses emit `total`; limits emit `max` — accept either.
  if (f.name && (f.max ?? f.total) != null) return `${f.name}: ${f.used}/${f.max ?? f.total}`;
  if (f.score != null) return `score ${f.score}% (floor ${f.floor}%)`;
  if (f.name) return String(f.name);
  return JSON.stringify(f);
}

/**
 * Shared presentational page for the audit/monitor snapshot shape:
 * { timestamp, org, checks: [{ id, title, status, summary, findings }], summary }
 */
export default function HealthChecks({ title, subtitle, pageKey, fetcher, command }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const chat = useContext(ChatContext);

  const load = useCallback(() => {
    setLoading(true);
    fetcher()
      .then((result) => {
        setData(result);
        if (result?.checks) {
          chat?.setPageContext({
            page: title,
            data: { checks: result.checks.map((c) => ({ title: c.title, status: c.status, summary: c.summary })) },
          });
        }
      })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [fetcher, chat, title]);

  useEffect(() => { load(); }, [load]);

  const checks = data?.checks ?? [];
  const summary = data?.summary ?? { ok: 0, warn: 0, fail: 0, error: 0 };
  const overall = summary.fail > 0 || summary.error > 0 ? 'fail' : summary.warn > 0 ? 'warn' : checks.length ? 'pass' : null;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>{title}</h1>
          <p className="page-subtitle">
            {data?.timestamp ? `Last run ${new Date(data.timestamp).toLocaleString()}${data.org ? ` · ${data.org}` : ''}` : subtitle}
          </p>
        </div>
        <div className="page-header-actions" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {overall && <StatusBadge status={overall} />}
          <button className="btn btn-sm" onClick={load} style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}>
            Refresh
          </button>
        </div>
      </div>

      {checks.length > 0 && (
        <div className="stats-grid mb-6" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <StatCard label="OK" value={summary.ok} accent="green" />
          <StatCard label="Warnings" value={summary.warn} accent={summary.warn > 0 ? 'amber' : 'brand'} />
          <StatCard label="Failures" value={summary.fail} accent={summary.fail > 0 ? 'red' : 'green'} />
          <StatCard label="Errors" value={summary.error} accent={summary.error > 0 ? 'red' : 'green'} />
        </div>
      )}

      {loading && <div className="spinner-center"><div className="spinner spinner-lg" /></div>}

      {!loading && checks.length === 0 && (
        <EmptyState
          title={`No ${pageKey} data`}
          message={`Run \`sfdt ${command}\` (CLI, MCP, or the VS Code extension) to generate a report.`}
        />
      )}

      {!loading && checks.map((c) => (
        <div key={c.id} className="card" style={{ marginBottom: 12 }}>
          <div className="card-head">
            <div className="card-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CheckIcon status={c.status} />
              {c.title}
            </div>
            <StatusBadge status={c.status} />
          </div>
          <div style={{ padding: '4px 12px 10px', color: 'var(--fg-muted)', fontSize: 13 }}>{c.summary}</div>
          {c.findings?.length > 0 && (
            <div>
              {c.findings.slice(0, 50).map((f, i) => (
                <div key={i} className="subtask pending">
                  <span className="s-icon"><span style={{ fontSize: 12, lineHeight: 1 }}>·</span></span>
                  <span className="s-name">{describeFinding(f)}</span>
                </div>
              ))}
              {c.findings.length > 50 && (
                <div className="subtask pending">
                  <span className="s-name" style={{ fontStyle: 'italic' }}>… and {c.findings.length - 50} more</span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
