import React, { useState, useMemo } from 'react';
import { IconSearch, IconFilter, IconPackage } from '../Icons.jsx';

const STATUS_OPTIONS = [
  { id: 'all',         label: 'All statuses' },
  { id: 'source-only', label: 'Source only' },
  { id: 'target-only', label: 'Target only' },
  { id: 'modified',    label: 'Modified' },
  { id: 'identical',   label: 'Identical' },
  { id: 'both',        label: 'Checking…' },
];

const TYPE_GROUPS = [
  { label: 'Code',            types: ['ApexClass', 'ApexTrigger', 'ApexPage', 'ApexComponent'] },
  { label: 'UI & Components', types: ['LightningComponentBundle', 'AuraDefinitionBundle', 'FlexiPage', 'Layout'] },
  { label: 'Automation',      types: ['Flow', 'Workflow', 'QuickAction', 'ValidationRule'] },
  { label: 'Data Model',      types: ['CustomObject', 'CustomField', 'CustomMetadata', 'RecordType', 'GlobalValueSet', 'CustomLabels'] },
  { label: 'Security',        types: ['Profile', 'PermissionSet', 'PermissionSetGroup', 'Role', 'Group', 'Queue'] },
];

function countsByStatus(items) {
  const c = {};
  for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
  return c;
}

const getNamespace = (name) => name.match(/^([A-Za-z0-9]+)__/)?.[1] ?? null;

const PILL_MAP = {
  'identical':    'pill-match',
  'match':        'pill-match',
  'modified':     'pill-mod',
  'both':         'pill-mod',
  'source-only':  'pill-add',
  'target-only':  'pill-rm',
  'conflict':     'pill-conflict',
};

const PILL_LABEL = {
  'identical':    'Match',
  'match':        'Match',
  'modified':     'Modified',
  'both':         'Checking…',
  'source-only':  'Added',
  'target-only':  'Removed',
  'conflict':     'Conflict',
};

function StatusPill({ status }) {
  const key = (status ?? '').toLowerCase();
  const cls  = PILL_MAP[key]  ?? 'pill-match';
  const label = PILL_LABEL[key] ?? status ?? '—';
  return <span className={`status-pill ${cls}`}>{label}</span>;
}

function NamespacedName({ name, onClick }) {
  const ns = getNamespace(name);
  if (!ns) {
    return (
      <button
        className="td-name"
        style={{ background: 'none', border: 'none', color: 'var(--fg-brand)', cursor: 'pointer', padding: 0, fontSize: 'inherit', fontWeight: 500 }}
        onClick={onClick}
      >
        {name}
      </button>
    );
  }
  const prefix = `${ns}__`;
  const rest = name.slice(prefix.length);
  return (
    <button
      className="td-name"
      style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, fontSize: 'inherit', fontWeight: 500 }}
      onClick={onClick}
    >
      <span style={{ color: 'var(--fg-muted)', fontFamily: 'var(--font-mono)', fontSize: 'var(--fs-xs)' }}>{prefix}</span>
      <span style={{ color: 'var(--fg-brand)' }}>{rest}</span>
    </button>
  );
}

export default function CompareTable({ items = [], onSelect, onBuildManifest, statusFilter: externalStatusFilter }) {
  const [search, setSearch]             = useState('');
  const [internalStatusFilter, setInternalStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  // If caller controls status filter externally, use that; otherwise use internal state
  const statusFilter = externalStatusFilter !== undefined ? externalStatusFilter : internalStatusFilter;
  const setStatusFilter = externalStatusFilter !== undefined ? () => {} : setInternalStatusFilter;
  const [selection, setSelection]       = useState(new Set());
  const [hideManaged, setHideManaged]   = useState(true);
  const [grouped, setGrouped]           = useState(false);

  const types = useMemo(() => {
    const t = [...new Set(items.map((i) => i.type))].sort();
    return ['all', ...t];
  }, [items]);

  // Map FilterTab labels to status matching predicates
  const statusMatchFn = useMemo(() => {
    const f = statusFilter;
    if (!f || f === 'all' || f === 'All') return null;  // no filter
    if (f === 'Modified')  return (s) => s === 'modified' || s === 'both';
    if (f === 'Added')     return (s) => s === 'source-only';
    if (f === 'Removed')   return (s) => s === 'target-only';
    if (f === 'Conflicts') return (s) => s === 'conflict';
    // raw status value (internal chip filter fallback)
    return (s) => s === f;
  }, [statusFilter]);

  const filtered = useMemo(() => items.filter((i) => {
    if (statusMatchFn && !statusMatchFn(i.status)) return false;
    if (typeFilter !== 'all' && i.type !== typeFilter) return false;
    if (hideManaged && getNamespace(i.member)) return false;
    if (search && !`${i.type}.${i.member}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [items, statusMatchFn, typeFilter, hideManaged, search]);

  const autoSelected = useMemo(() => new Set(
    items
      .filter((i) => i.status === 'source-only' || i.status === 'modified')
      .map((i) => `${i.type}.${i.member}`),
  ), [items]);

  // Selection is always explicit; fallback to autoSelected happens only in handleBuildManifest
  const effectiveSel = selection;

  const toggleRow = (key) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleBuildManifest = () => {
    // Use explicit selection if any; otherwise fall back to autoSelected
    const source = selection.size > 0 ? selection : autoSelected;
    const selected = items.filter((i) => source.has(`${i.type}.${i.member}`));
    onBuildManifest?.(selected);
  };

  const counts = useMemo(() => countsByStatus(items), [items]);

  const groupedRows = useMemo(() => {
    if (!grouped) return null;
    const groups = TYPE_GROUPS.map((g) => ({
      label: g.label,
      items: filtered.filter((i) => g.types.includes(i.type)),
    })).filter((g) => g.items.length > 0);

    const assignedKeys = new Set(TYPE_GROUPS.flatMap((g) => g.types));
    const other = filtered.filter((i) => !assignedKeys.has(i.type));
    if (other.length > 0) groups.push({ label: 'Other', items: other });
    return groups;
  }, [grouped, filtered]);

  const renderRow = (item) => {
    const key = `${item.type}.${item.member}`;
    const checked = effectiveSel.has(key);
    return (
      <tr key={key} className="compare-row">
        <td>
          <input
            type="checkbox"
            className="cbx"
            checked={checked}
            onChange={() => toggleRow(key)}
          />
        </td>
        <td>
          <NamespacedName name={item.member} onClick={() => onSelect?.(item)} />
        </td>
        <td>
          <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
            {item.type}
          </span>
        </td>
        <td><StatusPill status={item.status} /></td>
      </tr>
    );
  };

  return (
    <div>
      {/* Filters */}
      <div className="filter-bar">
        <div className="input-wrap has-icon search-wrap" style={{ flex: 1, maxWidth: 340 }}>
          <span className="input-icon"><IconSearch size={13} /></span>
          <input
            className="input"
            placeholder="Search components…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {externalStatusFilter === undefined && STATUS_OPTIONS.filter((o) => o.id !== 'all').map((o) => {
          const n = counts[o.id] ?? 0;
          if (!n) return null;
          return (
            <button
              key={o.id}
              className={`filter-chip${internalStatusFilter === o.id ? ' active' : ''}`}
              onClick={() => setInternalStatusFilter(internalStatusFilter === o.id ? 'all' : o.id)}
            >
              {o.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: .7 }}>{n}</span>
            </button>
          );
        })}

        <button
          className={`filter-chip${hideManaged ? ' active' : ''}`}
          onClick={() => setHideManaged((v) => !v)}
        >
          Hide Managed
        </button>

        <button
          className={`filter-chip${grouped ? ' active' : ''}`}
          onClick={() => setGrouped((v) => !v)}
        >
          Group by type
        </button>

        {types.length > 2 && (
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconFilter size={12} style={{ color: 'var(--fg-subtle)' }} />
            <select
              className="input"
              style={{ width: 'auto', paddingRight: 28, fontSize: 'var(--fs-xs)' }}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <option value="all">All types</option>
              {types.filter((t) => t !== 'all').map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {autoSelected.size > 0 && selection.size === 0 && (
        <div style={{ marginBottom: 'var(--s-2)' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setSelection(new Set(autoSelected))}
          >
            Select recommended ({autoSelected.size})
          </button>
        </div>
      )}
      {autoSelected.size === 0 && selection.size === 0 && filtered.length > 0 && (
        <div style={{ marginBottom: 'var(--s-2)' }}>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => setSelection(new Set(filtered.map((i) => `${i.type}.${i.member}`)))}
          >
            Select all visible ({filtered.length})
          </button>
        </div>
      )}

      {selection.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-label">{selection.size} selected</span>
          <span className="bulk-spacer" />
          <button className="btn btn-primary btn-sm" onClick={handleBuildManifest}>
            Build manifest
          </button>
        </div>
      )}

      {/* Table */}
      <div className="table-wrap">
        {filtered.length === 0 ? (
          <div className="empty-state" style={{ padding: 'var(--s-8)' }}>
            <div className="empty-icon"><IconPackage size={16} /></div>
            <p className="empty-title" style={{ fontSize: 'var(--fs-sm)' }}>No results</p>
            <p className="empty-desc">Try adjusting your filters.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 32 }}>
                  <input
                    type="checkbox"
                    className="cbx"
                    checked={filtered.length > 0 && filtered.every((i) => effectiveSel.has(`${i.type}.${i.member}`))}
                    onChange={(e) => {
                      const keys = filtered.map((i) => `${i.type}.${i.member}`);
                      setSelection((prev) => {
                        if (e.target.checked) return new Set([...prev, ...keys]);
                        const keySet = new Set(keys);
                        return new Set([...prev].filter((k) => !keySet.has(k)));
                      });
                    }}
                  />
                </th>
                <th>Component</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {grouped
                ? (groupedRows ?? []).map((group) => (
                    <React.Fragment key={`group-${group.label}`}>
                      <tr>
                        <td
                          colSpan={4}
                          style={{
                            background: 'var(--bg-subtle)',
                            color: 'var(--fg-muted)',
                            fontSize: 'var(--fs-xs)',
                            fontWeight: 600,
                            padding: '4px 8px',
                            letterSpacing: '0.05em',
                            textTransform: 'uppercase',
                          }}
                        >
                          {group.label}
                          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 400, opacity: 0.6, marginLeft: 6 }}>
                            {group.items.length}
                          </span>
                        </td>
                      </tr>
                      {group.items.map(renderRow)}
                    </React.Fragment>
                  ))
                : filtered.map(renderRow)
              }
            </tbody>
          </table>
        )}
      </div>

      {/* Footer summary */}
      {items.length > 0 && (
        <div className="mt-2" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', fontFamily: 'var(--font-mono)' }}>
          {filtered.length} of {items.length} · {counts['source-only'] ?? 0} source-only · {counts['target-only'] ?? 0} target-only · {counts.modified ?? 0} modified · {counts.identical ?? 0} identical
          {counts.both ? ` · ${counts.both} checking…` : ''}
        </div>
      )}
    </div>
  );
}
