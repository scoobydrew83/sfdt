import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { api } from '../api.js';
import {
  IconCopy, IconDownload, IconAlertTri, IconSearch, IconRefresh, IconX,
} from '../Icons.jsx';

// Local-source type list mirrors the TYPE_MAP in the server's
// GET /api/manifest/discover route — types outside this list return no
// members from the local glob, so offering them would only show empty grids.
const LOCAL_TYPES = [
  'ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent',
  'LightningComponentBundle', 'AuraDefinitionBundle',
  'Flow', 'FlowDefinition',
  'CustomObject', 'CustomField', 'Layout', 'FlexiPage',
  'PermissionSet', 'PermissionSetGroup', 'Profile',
  'StaticResource', 'ContentAsset',
  'CustomMetadata', 'CustomPermission', 'CustomTab',
  'ValidationRule', 'EmailTemplate', 'Report', 'Dashboard',
];

// Where the destructive-changes pairing + deploy timing (SFDT_DESTRUCTIVE_TIMING)
// behaviour is documented for users.
const DESTRUCTIVE_DOCS_URL = 'https://sfdt.dev/cli/dashboard#manifest-builder';

const storageKey = (sourceKey) => `sfdt-manifest-builder:${sourceKey}`;

const emptySelection = () => ({ wildcards: new Set(), members: new Map() });

function loadSelection(sourceKey) {
  try {
    const raw = localStorage.getItem(storageKey(sourceKey));
    if (!raw) return emptySelection();
    const parsed = JSON.parse(raw);
    return {
      wildcards: new Set(parsed.wildcards ?? []),
      members: new Map(
        Object.entries(parsed.members ?? {}).map(([t, ms]) => [t, new Set(ms)]),
      ),
    };
  } catch {
    return emptySelection();
  }
}

function persistSelection(sourceKey, sel) {
  try {
    localStorage.setItem(storageKey(sourceKey), JSON.stringify({
      wildcards: [...sel.wildcards],
      members: Object.fromEntries([...sel.members].map(([t, ms]) => [t, [...ms]])),
    }));
  } catch { /* storage unavailable — selection just won't persist */ }
}

/** Flatten a selection into the `[{type, member}]` items the render/save routes take. */
function selectionToItems(sel) {
  const items = [];
  for (const type of [...sel.wildcards].sort()) items.push({ type, member: '*' });
  for (const [type, members] of [...sel.members].sort(([a], [b]) => a.localeCompare(b))) {
    if (sel.wildcards.has(type)) continue; // wildcard supersedes explicit members
    for (const member of [...members].sort()) items.push({ type, member });
  }
  return items;
}

function download(filename, content) {
  const blob = new Blob([content], { type: 'application/xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export default function ManifestBuilderPage() {
  const [source, setSource]             = useState('org');   // 'org' | 'local'
  const [orgs, setOrgs]                 = useState([]);
  const [org, setOrg]                   = useState('');
  const [mode, setMode]                 = useState('additive'); // 'additive' | 'destructive'

  const [types, setTypes]               = useState([]);
  const [typesLoading, setTypesLoading] = useState(false);
  const [typesError, setTypesError]     = useState(null);
  const [typesCached, setTypesCached]   = useState(false);

  const [selectedType, setSelectedType]     = useState(null);
  const [membersByType, setMembersByType]   = useState({}); // { [type]: string[] }
  const [membersLoading, setMembersLoading] = useState(false);
  const [membersError, setMembersError]     = useState(null);

  const [typeSearch, setTypeSearch]     = useState('');
  const [memberFilter, setMemberFilter] = useState('');

  const [sel, setSel] = useState(emptySelection);

  const [preview, setPreview]           = useState(null); // render response
  const [previewError, setPreviewError] = useState(null);
  const [previewTab, setPreviewTab]     = useState('destructive'); // 'destructive' | 'empty'

  const [saveName, setSaveName]     = useState('');
  const [saving, setSaving]         = useState(false);
  const [saveResult, setSaveResult] = useState(null);
  const [saveError, setSaveError]   = useState(null);
  const [copied, setCopied]         = useState(false);

  // Selections persist per org (and separately for the local source).
  const sourceKey = source === 'org' ? (org || null) : 'local';

  // ── Bootstrap: orgs + session org ─────────────────────────────────────────
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

  // ── Restore persisted selection when the source key changes ───────────────
  useEffect(() => {
    if (!sourceKey) { setSel(emptySelection()); return; }
    setSel(loadSelection(sourceKey));
  }, [sourceKey]);

  useEffect(() => {
    if (sourceKey) persistSelection(sourceKey, sel);
  }, [sel, sourceKey]);

  // ── Type list per source ──────────────────────────────────────────────────
  const loadTypes = useCallback(async ({ refresh = false } = {}) => {
    setTypesError(null);
    setSelectedType(null);
    setMembersByType({});
    setMemberFilter('');
    if (source === 'local') {
      setTypes(LOCAL_TYPES);
      setTypesCached(false);
      return;
    }
    if (!org) { setTypes([]); return; }
    setTypesLoading(true);
    setTypes([]);
    try {
      const r = await api.discoverOrgTypes(org, { refresh });
      setTypes(r.types ?? []);
      setTypesCached(Boolean(r.cached));
    } catch (err) {
      // Org discovery failed — show the error, never a fabricated empty tree.
      setTypesError(err.message ?? 'Could not list metadata types');
    } finally {
      setTypesLoading(false);
    }
  }, [source, org]);

  useEffect(() => { loadTypes(); }, [loadTypes]);

  // ── Members for the selected type ─────────────────────────────────────────
  const loadMembers = useCallback(async (type, { refresh = false } = {}) => {
    setMembersError(null);
    if (!refresh && membersByType[type]) return;
    setMembersLoading(true);
    try {
      const r = source === 'org'
        ? await api.discoverOrgMembers(org, type, { refresh })
        : await api.discoverComponents(type);
      setMembersByType((prev) => ({ ...prev, [type]: r.members ?? [] }));
    } catch (err) {
      setMembersError(err.message ?? `Could not list ${type} members`);
    } finally {
      setMembersLoading(false);
    }
  }, [source, org, membersByType]);

  const pickType = (type) => {
    setSelectedType(type);
    setMemberFilter('');
    loadMembers(type);
  };

  // ── Selection model ───────────────────────────────────────────────────────
  const toggleMember = (type, member) => setSel((prev) => {
    const members = new Map(prev.members);
    const set = new Set(members.get(type) ?? []);
    set.has(member) ? set.delete(member) : set.add(member);
    set.size ? members.set(type, set) : members.delete(type);
    return { ...prev, members };
  });

  const toggleWildcard = (type) => setSel((prev) => {
    const wildcards = new Set(prev.wildcards);
    wildcards.has(type) ? wildcards.delete(type) : wildcards.add(type);
    return { ...prev, wildcards };
  });

  const setAllVisible = (type, visibleMembers, checked) => setSel((prev) => {
    const members = new Map(prev.members);
    const set = new Set(members.get(type) ?? []);
    visibleMembers.forEach((m) => (checked ? set.add(m) : set.delete(m)));
    set.size ? members.set(type, set) : members.delete(type);
    return { ...prev, members };
  });

  const clearAll = () => setSel(emptySelection());

  const items = useMemo(() => selectionToItems(sel), [sel]);
  const selectedMemberCount = useMemo(
    () => [...sel.members.entries()]
      .filter(([t]) => !sel.wildcards.has(t))
      .reduce((n, [, ms]) => n + ms.size, 0),
    [sel],
  );

  // ── Live XML preview — server-rendered on every selection tick ────────────
  const previewTimer = useRef(null);
  const previewSeq = useRef(0);
  useEffect(() => {
    clearTimeout(previewTimer.current);
    setSaveResult(null);
    setSaveError(null);
    if (items.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    const seq = ++previewSeq.current;
    previewTimer.current = setTimeout(async () => {
      try {
        // Single-writer rule: the XML always comes from the server's
        // renderPackageXml — the page never assembles XML itself.
        const r = await api.renderManifest({ items, mode });
        if (previewSeq.current !== seq) return;
        setPreview(r);
        setPreviewError(null);
      } catch (err) {
        if (previewSeq.current !== seq) return;
        setPreviewError(err.message ?? 'Render failed');
      }
    }, 250);
    return () => clearTimeout(previewTimer.current);
  }, [items, mode]);

  const previewXml = preview
    ? (mode === 'destructive'
      ? (previewTab === 'empty' ? preview.emptyPackageXml : preview.destructiveChangesXml)
      : preview.xml)
    : '';

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!saveName || items.length === 0) return;
    setSaving(true);
    setSaveResult(null);
    setSaveError(null);
    try {
      const r = await api.saveManifest({ name: saveName, mode, items });
      setSaveResult(r);
    } catch (err) {
      setSaveError(err.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(previewXml ?? '');
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };

  const handleDownload = () => {
    if (!previewXml) return;
    const base = saveName || 'manifest';
    const filename = mode === 'destructive'
      ? (previewTab === 'empty' ? `rl-${base}-package.xml` : `rl-${base}-destructiveChanges.xml`)
      : `rl-${base}-package.xml`;
    download(filename, previewXml);
  };

  // ── Derived view data ─────────────────────────────────────────────────────
  const visibleTypes = typeSearch
    ? types.filter((t) => t.toLowerCase().includes(typeSearch.toLowerCase()))
    : types;

  const currentMembers = selectedType ? (membersByType[selectedType] ?? []) : [];
  const visibleMembers = memberFilter
    ? currentMembers.filter((m) => m.toLowerCase().includes(memberFilter.toLowerCase()))
    : currentMembers;

  const typeSelCount = (type) =>
    sel.wildcards.has(type) ? '*' : (sel.members.get(type)?.size || null);

  const wholeTypeChecked = selectedType ? sel.wildcards.has(selectedType) : false;
  const allVisibleChecked = selectedType && visibleMembers.length > 0 &&
    visibleMembers.every((m) => sel.members.get(selectedType)?.has(m));

  const canBrowse = source === 'local' || Boolean(org);

  return (
    <div>
      {/* Page header */}
      <div className="page-header">
        <div className="page-header-text">
          <h1>Manifest Builder</h1>
          <p className="page-subtitle">
            Browse metadata, tick components, and build a package.xml — or a destructiveChanges.xml pair.
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="card mb-4">
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            {/* Source toggle */}
            <div className="input-field">
              <label className="input-label">Source</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {['org', 'local'].map((s) => (
                  <button
                    key={s}
                    className={`btn btn-sm ${source === s ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setSource(s)}
                  >
                    {s === 'org' ? 'Org' : 'Local'}
                  </button>
                ))}
              </div>
            </div>

            {/* Org picker (org source only) */}
            {source === 'org' && (
              <div className="input-field" style={{ minWidth: 180 }}>
                <label className="input-label">Org</label>
                <select className="input" value={org} onChange={(e) => setOrg(e.target.value)}>
                  <option value="">Select org…</option>
                  {orgs.map((o) => (
                    <option key={o.alias} value={o.alias}>{o.alias}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Mode toggle */}
            <div className="input-field">
              <label className="input-label">Mode</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className={`btn btn-sm ${mode === 'additive' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setMode('additive')}
                >
                  Additive
                </button>
                <button
                  className={`btn btn-sm ${mode === 'destructive' ? 'btn-primary' : 'btn-secondary'}`}
                  style={mode === 'destructive'
                    ? { background: 'var(--status-conflict-fg)', borderColor: 'var(--status-conflict-fg)' }
                    : { color: 'var(--status-conflict-fg)', borderColor: 'var(--status-conflict-border)' }}
                  onClick={() => setMode('destructive')}
                >
                  <IconAlertTri size={12} /> Destructive
                </button>
              </div>
            </div>

            <span style={{ flex: 1 }} />

            {source === 'org' && (
              <button
                className="btn btn-secondary btn-sm"
                disabled={!org || typesLoading}
                title="Re-query the org instead of the cached scan snapshot"
                onClick={() => loadTypes({ refresh: true })}
              >
                <IconRefresh size={12} /> Refresh from org
              </button>
            )}
          </div>

          {source === 'org' && typesCached && (
            <p style={{ marginTop: 'var(--s-2)', marginBottom: 0, fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              Types served from the latest scan snapshot — use “Refresh from org” for live data.
            </p>
          )}
        </div>
      </div>

      {/* Destructive mode warning */}
      {mode === 'destructive' && (
        <div className="alert alert-warning mb-4" role="alert">
          <IconAlertTri size={15} />
          <div>
            <div className="alert-title">Destructive mode — components will be DELETED from the target org</div>
            <div style={{ fontSize: 'var(--fs-xs)' }}>
              Saving writes a paired set: <code>rl-&lt;name&gt;-destructiveChanges.xml</code> (the deletions)
              plus an empty <code>rl-&lt;name&gt;-package.xml</code>, because the Metadata API requires a
              package.xml alongside destructive changes. When this pair is deployed, the
              <code> SFDT_DESTRUCTIVE_TIMING</code> setting (pre / post / none / only) controls when the
              deletions run.{' '}
              <a href={DESTRUCTIVE_DOCS_URL} target="_blank" rel="noreferrer">Read the docs</a> before deploying.
            </div>
          </div>
        </div>
      )}

      {/* Org discovery error — visible error state, never an empty tree */}
      {typesError && (
        <div className="alert alert-error mb-4" role="alert">
          <span style={{ flex: 1 }}>{typesError}</span>
          <button className="btn btn-secondary btn-sm" onClick={() => loadTypes()}>Retry</button>
        </div>
      )}

      {/* Bulk bar */}
      {items.length > 0 && (
        <div className="bulk-bar mb-4">
          <span className="bulk-label">
            {sel.wildcards.size > 0 && `${sel.wildcards.size} whole type${sel.wildcards.size !== 1 ? 's' : ''} (*)`}
            {sel.wildcards.size > 0 && selectedMemberCount > 0 && ' · '}
            {selectedMemberCount > 0 && `${selectedMemberCount} member${selectedMemberCount !== 1 ? 's' : ''}`}
            {' selected'}
          </span>
          <span className="bulk-spacer" />
          <button className="btn btn-ghost btn-sm" onClick={clearAll}>
            <IconX size={12} /> Clear all
          </button>
        </div>
      )}

      {!canBrowse && (
        <div className="card">
          <div className="card-body">
            <p style={{ color: 'var(--fg-muted)', margin: 0 }}>
              Select an org above (or switch the source to Local) to browse metadata.
            </p>
          </div>
        </div>
      )}

      {canBrowse && (
        <div className="card">
          <div className="card-body" style={{ padding: 0, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr 1fr', height: 560 }}>

              {/* Left panel: type list */}
              <div style={{ borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: 'var(--s-2)', borderBottom: '1px solid var(--border-subtle)' }}>
                  <div className="input-wrap has-icon">
                    <span className="input-icon"><IconSearch size={12} /></span>
                    <input
                      className="input"
                      style={{ width: '100%' }}
                      placeholder="Filter types…"
                      value={typeSearch}
                      onChange={(e) => setTypeSearch(e.target.value)}
                    />
                  </div>
                </div>
                <div style={{ overflowY: 'auto', flex: 1 }}>
                  {typesLoading && <div className="spinner-center" style={{ padding: 'var(--s-6)' }}><div className="spinner" /></div>}
                  {!typesLoading && visibleTypes.map((type) => {
                    const count = typeSelCount(type);
                    return (
                      <button
                        key={type}
                        style={{
                          width: '100%', textAlign: 'left', padding: 'var(--s-2) var(--s-3)',
                          borderRadius: 0, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          background: selectedType === type ? 'var(--brand-500)' : 'transparent',
                          color: selectedType === type ? '#fff' : 'var(--fg-default)',
                          border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                        }}
                        onClick={() => pickType(type)}
                      >
                        <span style={{ fontSize: 'var(--fs-sm)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{type}</span>
                        {count && (
                          <span
                            className="badge badge-info"
                            style={{ fontSize: 10, fontFamily: 'var(--font-mono)', flexShrink: 0 }}
                          >
                            {count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                  {!typesLoading && visibleTypes.length === 0 && !typesError && (
                    <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)' }}>
                      No types{typeSearch ? ' match' : ' found'}.
                    </p>
                  )}
                </div>
              </div>

              {/* Middle panel: member grid */}
              <div style={{ borderRight: '1px solid var(--border-subtle)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                {selectedType ? (
                  <>
                    <div style={{ padding: 'var(--s-2) var(--s-3)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      {/* Per-type header checkbox → wildcard */}
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', flexShrink: 0 }}>
                        <input
                          type="checkbox"
                          className="cbx"
                          checked={wholeTypeChecked}
                          onChange={() => toggleWildcard(selectedType)}
                        />
                        <span style={{ fontSize: 'var(--fs-xs)', fontWeight: 600 }}>
                          Entire type <span style={{ fontFamily: 'var(--font-mono)' }}>(*)</span>
                        </span>
                      </label>
                      <input
                        className="input"
                        style={{ flex: 1, minWidth: 120 }}
                        placeholder={`Filter ${selectedType}…`}
                        value={memberFilter}
                        onChange={(e) => setMemberFilter(e.target.value)}
                      />
                    </div>

                    {membersError && (
                      <div className="alert alert-error" style={{ margin: 'var(--s-3)' }} role="alert">
                        <span style={{ flex: 1 }}>{membersError}</span>
                        <button className="btn btn-secondary btn-sm" onClick={() => loadMembers(selectedType, { refresh: true })}>Retry</button>
                      </div>
                    )}

                    <div style={{ overflowY: 'auto', flex: 1 }}>
                      {membersLoading && <div className="spinner-center" style={{ padding: 'var(--s-6)' }}><div className="spinner" /></div>}

                      {!membersLoading && !membersError && visibleMembers.length > 0 && (
                        <>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px var(--s-3)', borderBottom: '1px solid var(--border-subtle)', cursor: wholeTypeChecked ? 'default' : 'pointer', background: 'var(--bg-subtle)' }}>
                            <input
                              type="checkbox"
                              className="cbx"
                              disabled={wholeTypeChecked}
                              checked={Boolean(allVisibleChecked)}
                              onChange={(e) => setAllVisible(selectedType, visibleMembers, e.target.checked)}
                            />
                            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                              Select all ({visibleMembers.length})
                            </span>
                          </label>
                          {visibleMembers.map((member) => {
                            const checked = wholeTypeChecked || Boolean(sel.members.get(selectedType)?.has(member));
                            return (
                              <label key={member} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px var(--s-3)', cursor: wholeTypeChecked ? 'default' : 'pointer' }}>
                                <input
                                  type="checkbox"
                                  className="cbx"
                                  disabled={wholeTypeChecked}
                                  checked={checked}
                                  onChange={() => toggleMember(selectedType, member)}
                                />
                                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={member}>
                                  {member}
                                </span>
                              </label>
                            );
                          })}
                        </>
                      )}

                      {!membersLoading && !membersError && currentMembers.length > 0 && visibleMembers.length === 0 && (
                        <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)' }}>No members match.</p>
                      )}
                      {!membersLoading && !membersError && currentMembers.length === 0 && (
                        <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)' }}>
                          No {selectedType} components found{source === 'local' ? ' in the local source path' : ' in this org'}.
                          {' '}Tick “Entire type (*)” to include the whole type anyway.
                        </p>
                      )}
                    </div>
                  </>
                ) : (
                  <p style={{ color: 'var(--fg-muted)', fontSize: 'var(--fs-sm)', padding: 'var(--s-3)' }}>
                    Select a metadata type to browse its members.
                  </p>
                )}
              </div>

              {/* Right panel: live XML preview */}
              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: 'var(--s-2) var(--s-3)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="section-label" style={{ marginBottom: 0 }}>
                    {mode === 'destructive' ? 'Destructive preview' : 'package.xml preview'}
                  </span>
                  <span style={{ flex: 1 }} />
                  {mode === 'destructive' && preview && (
                    <div style={{ display: 'flex', gap: 4 }}>
                      <button
                        className={`filter-chip${previewTab === 'destructive' ? ' active' : ''}`}
                        onClick={() => setPreviewTab('destructive')}
                      >
                        destructiveChanges.xml
                      </button>
                      <button
                        className={`filter-chip${previewTab === 'empty' ? ' active' : ''}`}
                        onClick={() => setPreviewTab('empty')}
                      >
                        package.xml (empty)
                      </button>
                    </div>
                  )}
                </div>

                <pre style={{
                  flex: 1, margin: 0, padding: 'var(--s-3)', overflow: 'auto',
                  fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
                  background: 'var(--bg-subtle)', color: 'var(--fg-default)',
                }}>
                  {previewError
                    ? `Render failed: ${previewError}`
                    : previewXml || 'Tick components to preview the manifest XML.'}
                </pre>

                {/* Save / copy / download */}
                <div style={{ padding: 'var(--s-3)', borderTop: '1px solid var(--border-subtle)' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      className="input"
                      style={{ flex: 1, minWidth: 110 }}
                      placeholder="Release name (e.g. 1.4.0)"
                      value={saveName}
                      onChange={(e) => setSaveName(e.target.value)}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={saving || !saveName || items.length === 0 || Boolean(previewError)}
                      onClick={handleSave}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button className="btn btn-secondary btn-sm" disabled={!previewXml} onClick={handleCopy}>
                      <IconCopy size={12} /> {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button className="btn btn-secondary btn-sm" disabled={!previewXml} onClick={handleDownload}>
                      <IconDownload size={12} />
                    </button>
                  </div>
                  {saveName && (
                    <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', marginTop: 6 }}>
                      → rl-{saveName}-{mode === 'destructive' ? 'destructiveChanges.xml (+ empty package.xml)' : 'package.xml'}
                    </div>
                  )}
                  {saveError && (
                    <div className="alert alert-error mt-2" role="alert"><span>{saveError}</span></div>
                  )}
                  {saveResult?.ok && (
                    <div className="alert alert-success mt-2" role="status">
                      <span>
                        Saved {saveResult.files?.map((f) => f.path).join(' and ')}
                      </span>
                    </div>
                  )}
                </div>
              </div>

            </div>
          </div>
        </div>
      )}
    </div>
  );
}
