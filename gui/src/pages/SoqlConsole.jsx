import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';
import {
  IconSearch, IconPlay, IconCheck, IconActivity, IconDownload, IconAlertTri,
} from '../Icons.jsx';

/**
 * SOQL Console — the dashboard surface of the `sfdt soql` family (D-4).
 *
 * Every action is a thin call to the /api/soql/* routes, which wrap
 * src/lib/soql-runner.js — the page reimplements no query logic. Execution is
 * bounded by the runner (soql.defaultLimit clamped to soql.maxLimit) and the
 * result carries bound/truncated metadata, which this page surfaces verbatim.
 * Exports download the raw records (JSON) or the runner-shaped CSV returned
 * by the server — there is no second, page-invented export format.
 */

function download(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

/** Union of top-level record keys, in first-seen order (matches toCsv's column rule). */
function recordColumns(records) {
  const cols = [];
  for (const r of records ?? []) {
    for (const key of Object.keys(r ?? {})) {
      if (!cols.includes(key)) cols.push(key);
    }
  }
  return cols;
}

function cellText(value) {
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const isSosl = (q) => /^\s*find\b/i.test(q ?? '');

export default function SoqlConsolePage() {
  const [orgs, setOrgs] = useState([]);
  const [org, setOrg]   = useState('');

  // ── Schema browser state ──────────────────────────────────────────────────
  const [term, setTerm]                 = useState('');
  const [category, setCategory]         = useState('all');
  const [sobjects, setSobjects]         = useState(null); // search response
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError]   = useState(null);

  const [selectedSObject, setSelectedSObject] = useState(null);
  const [describe, setDescribe]         = useState(null);
  const [relationships, setRelationships] = useState(null);
  const [detailTab, setDetailTab]       = useState('fields'); // 'fields' | 'relationships'
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError]   = useState(null);
  const [fieldFilter, setFieldFilter]   = useState('');

  // ── Query editor state ────────────────────────────────────────────────────
  const [query, setQuery]     = useState('');
  const [limit, setLimit]     = useState('');
  const [tooling, setTooling] = useState(false);
  const [allRows, setAllRows] = useState(false);

  const [busy, setBusy]       = useState(null);   // 'validate' | 'plan' | 'run' | null
  const [outcome, setOutcome] = useState(null);   // { kind: 'validate'|'plan'|'run', data }
  const [runError, setRunError] = useState(null);

  // ── Bootstrap: orgs + session org (same idiom as ManifestBuilder) ─────────
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.orgs().catch(() => ({ orgs: [] })),
      api.sessionOrg().catch(() => ({ org: null })),
    ]).then(([{ orgs: list = [] }, { org: session }]) => {
      if (cancelled) return;
      setOrgs(list);
      const initial = session && list.some((o) => o.alias === session)
        ? session
        : list[0]?.alias ?? '';
      setOrg(initial);
    });
    return () => { cancelled = true; };
  }, []);

  // ── Schema browse ─────────────────────────────────────────────────────────
  const handleSearch = useCallback(async () => {
    if (!org) return;
    setSchemaError(null);
    setSchemaLoading(true);
    try {
      const r = await api.soqlSObjects(org, { term: term || undefined, category });
      setSobjects(r);
    } catch (err) {
      // Real error state, never a fabricated empty list.
      setSchemaError(err.message ?? 'Schema search failed');
      setSobjects(null);
    } finally {
      setSchemaLoading(false);
    }
  }, [org, term, category]);

  const pickSObject = useCallback(async (name) => {
    setSelectedSObject(name);
    setDescribe(null);
    setRelationships(null);
    setDetailTab('fields');
    setDetailError(null);
    setFieldFilter('');
    setDetailLoading(true);
    try {
      setDescribe(await api.soqlDescribe(org, name));
    } catch (err) {
      setDetailError(err.message ?? `Describe of ${name} failed`);
    } finally {
      setDetailLoading(false);
    }
  }, [org]);

  const openRelationships = useCallback(async () => {
    setDetailTab('relationships');
    if (relationships || !selectedSObject) return;
    setDetailError(null);
    setDetailLoading(true);
    try {
      setRelationships(await api.soqlRelationships(org, selectedSObject));
    } catch (err) {
      setDetailError(err.message ?? 'Relationship discovery failed');
    } finally {
      setDetailLoading(false);
    }
  }, [org, selectedSObject, relationships]);

  // ── Query actions ─────────────────────────────────────────────────────────
  const runAction = useCallback(async (kind) => {
    if (!query.trim() || busy) return;
    setBusy(kind);
    setRunError(null);
    setOutcome(null);
    try {
      if (kind === 'validate') {
        setOutcome({ kind, data: await api.soqlValidate({ query, org: org || undefined, tooling }) });
      } else if (kind === 'plan') {
        setOutcome({ kind, data: await api.soqlPlan({ query, org: org || undefined }) });
      } else {
        const body = { query, org: org || undefined, ...(limit ? { limit } : {}) };
        const data = isSosl(query)
          ? await api.soqlSosl(body)
          : await api.soqlQuery({ ...body, tooling, allRows });
        setOutcome({ kind: 'run', data });
      }
    } catch (err) {
      setRunError(err.message ?? 'Request failed');
    } finally {
      setBusy(null);
    }
  }, [query, org, tooling, allRows, limit, busy]);

  const seedQuery = (name) => setQuery(`SELECT Id FROM ${name} LIMIT 10`);

  const runData = outcome?.kind === 'run' ? outcome.data : null;

  const exportJson = () => {
    if (!runData) return;
    // Same shape writeExport puts on disk: raw records, 2-space indent.
    download('soql-results.json', `${JSON.stringify(runData.records, null, 2)}\n`, 'application/json');
  };
  const exportCsv = () => {
    if (!runData) return;
    // Server-rendered by the runner's toCsv — the single CSV shaping.
    download('soql-results.csv', runData.csv ?? '', 'text/csv');
  };

  // ── Derived view data ─────────────────────────────────────────────────────
  const visibleFields = describe
    ? (fieldFilter
      ? describe.fields.filter((f) =>
        f.name?.toLowerCase().includes(fieldFilter.toLowerCase()) ||
        f.label?.toLowerCase().includes(fieldFilter.toLowerCase()))
      : describe.fields)
    : [];

  const columns = runData ? recordColumns(runData.records) : [];

  const boundNote = runData?.bound
    ? (runData.bound.action === 'kept'
      ? `in-query LIMIT ${runData.bound.limit} kept`
      : runData.bound.action === 'clamped'
        ? `LIMIT clamped to ${runData.bound.limit} (max ${runData.bound.max})`
        : `LIMIT ${runData.bound.limit} applied`)
    : '';

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="page-header-text">
          <h1>SOQL Console</h1>
          <p className="page-subtitle">
            Browse the org schema, validate and plan queries, and run them with the configured row bound — the same engine as <code>sfdt soql</code>.
          </p>
        </div>
      </div>

      {/* Org picker */}
      <div className="card mb-4">
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <div className="input-field" style={{ minWidth: 180 }}>
              <label className="input-label">Org</label>
              <select className="input" value={org} onChange={(e) => setOrg(e.target.value)}>
                <option value="">Select org…</option>
                {orgs.map((o) => (
                  <option key={o.alias} value={o.alias}>{o.alias}</option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 380px) 1fr', gap: 'var(--s-4)', alignItems: 'start' }}>

        {/* ── Left: schema browser ─────────────────────────────────────────── */}
        <div className="card">
          <div className="card-head"><div className="card-title">Schema</div></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <div className="input-wrap has-icon" style={{ flex: 1 }}>
                <span className="input-icon"><IconSearch size={12} /></span>
                <input
                  className="input"
                  style={{ width: '100%' }}
                  placeholder="Find sObjects…"
                  value={term}
                  onChange={(e) => setTerm(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearch(); }}
                />
              </div>
              <select className="input" style={{ width: 100 }} value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="all">all</option>
                <option value="custom">custom</option>
                <option value="standard">standard</option>
              </select>
              <button className="btn btn-secondary btn-sm" disabled={!org || schemaLoading} onClick={handleSearch}>
                Search
              </button>
            </div>

            {schemaError && (
              <div className="alert alert-error" role="alert">
                <span style={{ flex: 1 }}>{schemaError}</span>
                <button className="btn btn-secondary btn-sm" onClick={handleSearch}>Retry</button>
              </div>
            )}

            {schemaLoading && <div className="spinner-center" style={{ padding: 'var(--s-4)' }}><div className="spinner" /></div>}

            {!schemaLoading && sobjects && (
              <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' }}>
                {sobjects.matches.map((name) => (
                  <button
                    key={name}
                    style={{
                      width: '100%', textAlign: 'left', padding: '4px var(--s-3)', borderRadius: 0,
                      background: selectedSObject === name ? 'var(--brand-500)' : 'transparent',
                      color: selectedSObject === name ? '#fff' : 'var(--fg-default)',
                      border: 'none', cursor: 'pointer', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)',
                    }}
                    onClick={() => pickSObject(name)}
                  >
                    {name}
                  </button>
                ))}
                {sobjects.matches.length === 0 && (
                  <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)', margin: 0 }}>No sObjects match.</p>
                )}
              </div>
            )}
            {!schemaLoading && sobjects?.truncated && (
              <p style={{ margin: 0, fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
                Showing {sobjects.matches.length} of {sobjects.totalMatched} matches — narrow the search term.
              </p>
            )}

            {/* Selected sObject detail */}
            {selectedSObject && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--s-2)', flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', fontWeight: 600 }}>{selectedSObject}</span>
                  {describe && (
                    <span className="badge badge-info" style={{ fontSize: 10 }}>{describe.fieldCount} fields</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-ghost btn-sm" title="Start a query on this object" onClick={() => seedQuery(selectedSObject)}>
                    Query this
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 4, marginBottom: 'var(--s-2)' }}>
                  <button className={`filter-chip${detailTab === 'fields' ? ' active' : ''}`} onClick={() => setDetailTab('fields')}>Fields</button>
                  <button className={`filter-chip${detailTab === 'relationships' ? ' active' : ''}`} onClick={openRelationships}>Relationships</button>
                </div>

                {detailError && (
                  <div className="alert alert-error" role="alert"><span>{detailError}</span></div>
                )}
                {detailLoading && <div className="spinner-center" style={{ padding: 'var(--s-4)' }}><div className="spinner" /></div>}

                {!detailLoading && detailTab === 'fields' && describe && (
                  <>
                    <input
                      className="input"
                      style={{ width: '100%', marginBottom: 'var(--s-2)' }}
                      placeholder="Filter fields…"
                      value={fieldFilter}
                      onChange={(e) => setFieldFilter(e.target.value)}
                    />
                    <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' }}>
                      {visibleFields.map((f) => (
                        <div key={f.name} style={{ display: 'flex', gap: 8, padding: '3px var(--s-2)', fontSize: 'var(--fs-xs)', alignItems: 'baseline' }}>
                          <span style={{ fontFamily: 'var(--font-mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={f.label}>{f.name}</span>
                          <span style={{ color: 'var(--fg-subtle)', flexShrink: 0 }}>
                            {f.type}{f.referenceTo?.length ? ` → ${f.referenceTo.join('|')}` : ''}
                          </span>
                        </div>
                      ))}
                      {visibleFields.length === 0 && (
                        <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-2)', margin: 0 }}>No fields match.</p>
                      )}
                    </div>
                  </>
                )}

                {!detailLoading && detailTab === 'relationships' && relationships && (
                  <div style={{ maxHeight: 280, overflowY: 'auto', fontSize: 'var(--fs-xs)' }}>
                    <div className="section-label">Parents (dot notation)</div>
                    {(relationships.parents ?? []).map((p) => (
                      <div key={p.field} style={{ padding: '2px 0', fontFamily: 'var(--font-mono)' }}>
                        {p.relationshipName ?? p.field} <span style={{ color: 'var(--fg-subtle)', fontFamily: 'inherit' }}>→ {p.referenceTo.join('|')}</span>
                      </div>
                    ))}
                    {(relationships.parents ?? []).length === 0 && <p style={{ color: 'var(--fg-muted)', margin: '2px 0' }}>(none)</p>}
                    <div className="section-label" style={{ marginTop: 'var(--s-2)' }}>Children (subqueries)</div>
                    {(relationships.children ?? []).map((c) => (
                      <div key={`${c.relationshipName}-${c.field}`} style={{ padding: '2px 0', fontFamily: 'var(--font-mono)' }}>
                        {c.relationshipName} <span style={{ color: 'var(--fg-subtle)', fontFamily: 'inherit' }}>{c.childSObject} ({c.field})</span>
                      </div>
                    ))}
                    {(relationships.children ?? []).length === 0 && <p style={{ color: 'var(--fg-muted)', margin: '2px 0' }}>(none)</p>}
                  </div>
                )}
              </div>
            )}

            {!sobjects && !schemaLoading && !schemaError && (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
                {org ? 'Search the org for sObjects to browse fields and relationships.' : 'Select an org to browse the schema.'}
              </p>
            )}
          </div>
        </div>

        {/* ── Right: query editor + results ────────────────────────────────── */}
        <div className="card">
          <div className="card-head"><div className="card-title">Query</div></div>
          <div className="card-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-3)' }}>
            <textarea
              className="input"
              style={{ width: '100%', minHeight: 110, fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-sm)', resize: 'vertical' }}
              placeholder="SELECT Id, Name FROM Account WHERE … — or FIND {term} for SOSL"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Query editor"
            />

            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-3)', flexWrap: 'wrap' }}>
              <button className="btn btn-secondary btn-sm" disabled={!query.trim() || Boolean(busy)} onClick={() => runAction('validate')}>
                <IconCheck size={12} /> {busy === 'validate' ? 'Validating…' : 'Validate'}
              </button>
              <button className="btn btn-secondary btn-sm" disabled={!query.trim() || Boolean(busy) || isSosl(query)} onClick={() => runAction('plan')}>
                <IconActivity size={12} /> {busy === 'plan' ? 'Planning…' : 'Plan'}
              </button>
              <button className="btn btn-primary btn-sm" disabled={!query.trim() || Boolean(busy)} onClick={() => runAction('run')}>
                <IconPlay size={12} /> {busy === 'run' ? 'Running…' : 'Run'}
              </button>
              <span style={{ flex: 1 }} />
              <label className="input-label" style={{ marginBottom: 0 }} htmlFor="soql-limit">Limit</label>
              <input
                id="soql-limit"
                className="input"
                style={{ width: 90 }}
                placeholder="default"
                title="Row bound — defaults to soql.defaultLimit, clamped to soql.maxLimit"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', cursor: 'pointer' }}>
                <input type="checkbox" className="cbx" checked={tooling} onChange={(e) => setTooling(e.target.checked)} />
                Tooling API
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 'var(--fs-xs)', cursor: 'pointer' }}>
                <input type="checkbox" className="cbx" checked={allRows} onChange={(e) => setAllRows(e.target.checked)} />
                All rows
              </label>
            </div>

            {runError && (
              <div className="alert alert-error" role="alert"><span>{runError}</span></div>
            )}

            {/* Validation outcome */}
            {outcome?.kind === 'validate' && (
              <div className={`alert ${outcome.data.valid ? 'alert-success' : 'alert-error'}`} role="status">
                <div>
                  <div className="alert-title">
                    {outcome.data.valid ? 'VALID' : 'INVALID'}
                    <span style={{ fontWeight: 400, color: 'var(--fg-muted)' }}> ({outcome.data.kind}, {outcome.data.mode} validation)</span>
                  </div>
                  {outcome.data.errors.map((e) => <div key={e} style={{ fontSize: 'var(--fs-xs)' }}>✗ {e}</div>)}
                  {outcome.data.warnings.map((w) => <div key={w} style={{ fontSize: 'var(--fs-xs)' }}>⚠ {w}</div>)}
                </div>
              </div>
            )}

            {/* Plan outcome */}
            {outcome?.kind === 'plan' && (
              <div>
                <div className="section-label">
                  Query plans (API v{outcome.data.apiVersion}) — lowest relativeCost wins
                </div>
                {outcome.data.plans.length === 0 && (
                  <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>No plans returned.</p>
                )}
                {outcome.data.plans.length > 0 && (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="table">
                      <thead>
                        <tr><th>Operation</th><th>Relative cost</th><th>Cardinality</th><th>Object cardinality</th><th>Leading fields</th></tr>
                      </thead>
                      <tbody>
                        {outcome.data.plans.map((p, i) => (
                          <tr key={i}>
                            <td>{p.leadingOperationType}</td>
                            <td>{p.relativeCost}</td>
                            <td>{p.cardinality}</td>
                            <td>{p.sobjectCardinality}</td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{(p.fields ?? []).join(', ') || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {outcome.data.plans.flatMap((p) => p.notes ?? []).map((n, i) => (
                  <p key={i} style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', margin: '2px 0' }}>
                    note: {n.description}{n.fields?.length ? ` [${n.fields.join(', ')}]` : ''}
                  </p>
                ))}
              </div>
            )}

            {/* Run outcome */}
            {runData && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 'var(--s-2)' }}>
                  <span style={{ fontWeight: 600 }}>
                    {runData.returned} row(s){runData.totalSize != null ? ` of ${runData.totalSize} total` : ''}
                  </span>
                  {boundNote && <span className="badge badge-info" style={{ fontSize: 10 }}>{boundNote}</span>}
                  <span style={{ flex: 1 }} />
                  <button className="btn btn-secondary btn-sm" disabled={!runData.records.length} onClick={exportJson}>
                    <IconDownload size={12} /> JSON
                  </button>
                  <button className="btn btn-secondary btn-sm" disabled={!runData.records.length} onClick={exportCsv}>
                    <IconDownload size={12} /> CSV
                  </button>
                </div>

                {runData.truncated && (
                  <div className="alert alert-warning mb-2" role="alert">
                    <IconAlertTri size={14} />
                    <span>
                      Result truncated at the row bound — raise the limit (max {runData.bound?.max}, config <code>soql.maxLimit</code>) or add a WHERE filter.
                    </span>
                  </div>
                )}

                {runData.records.length === 0 && (
                  <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)' }}>Query returned no rows.</p>
                )}
                {runData.records.length > 0 && (
                  <div style={{ overflowX: 'auto', maxHeight: 420, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 'var(--r-sm)' }}>
                    <table className="table">
                      <thead>
                        <tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr>
                      </thead>
                      <tbody>
                        {runData.records.map((r, i) => (
                          <tr key={i}>
                            {columns.map((c) => (
                              <td key={c} style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={cellText(r[c])}>
                                {cellText(r[c])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {!outcome && !runError && (
              <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
                Validate checks the query without materialising rows (org LIMIT 0 round-trip); Plan fetches the org's
                query plans without executing; Run executes with the configured row bound — never unbounded.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
