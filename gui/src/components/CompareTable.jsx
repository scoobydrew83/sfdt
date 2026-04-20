import { useState, useMemo } from 'react';
import StatusBadge from './StatusBadge.jsx';
import { IconSearch, IconFilter, IconPackage } from '../Icons.jsx';

const STATUS_OPTIONS = [
  { id: 'all',         label: 'All statuses' },
  { id: 'source-only', label: 'Source only' },
  { id: 'target-only', label: 'Target only' },
  { id: 'modified',    label: 'Modified' },
  { id: 'identical',   label: 'Identical' },
  { id: 'both',        label: 'Checking…' },
];

function countsByStatus(items) {
  const c = {};
  for (const i of items) c[i.status] = (c[i.status] ?? 0) + 1;
  return c;
}

export default function CompareTable({ items = [], onSelect, onBuildManifest }) {
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  const [selection, setSelection]       = useState(new Set());

  const types = useMemo(() => {
    const t = [...new Set(items.map((i) => i.type))].sort();
    return ['all', ...t];
  }, [items]);

  const filtered = useMemo(() => items.filter((i) => {
    if (statusFilter !== 'all' && i.status !== statusFilter) return false;
    if (typeFilter !== 'all' && i.type !== typeFilter) return false;
    if (search && !`${i.type}.${i.member}`.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  }), [items, statusFilter, typeFilter, search]);

  const autoSelected = useMemo(() => new Set(
    items
      .filter((i) => i.status === 'source-only' || i.status === 'modified')
      .map((i) => `${i.type}.${i.member}`),
  ), [items]);

  const effectiveSel = selection.size === 0 ? autoSelected : selection;

  const toggleRow = (key) => {
    setSelection((prev) => {
      const base = prev.size === 0 ? new Set(autoSelected) : new Set(prev);
      if (base.has(key)) base.delete(key); else base.add(key);
      return base;
    });
  };

  const handleBuildManifest = () => {
    const selected = items.filter((i) => effectiveSel.has(`${i.type}.${i.member}`));
    onBuildManifest?.(selected);
  };

  const counts = useMemo(() => countsByStatus(items), [items]);

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

        {STATUS_OPTIONS.filter((o) => o.id !== 'all').map((o) => {
          const n = counts[o.id] ?? 0;
          if (!n) return null;
          return (
            <button
              key={o.id}
              className={`filter-chip${statusFilter === o.id ? ' active' : ''}`}
              onClick={() => setStatusFilter(statusFilter === o.id ? 'all' : o.id)}
            >
              {o.label}
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, opacity: .7 }}>{n}</span>
            </button>
          );
        })}

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

      {/* Bulk bar */}
      {effectiveSel.size > 0 && (
        <div className="bulk-bar">
          <span className="bulk-label">{effectiveSel.size} selected</span>
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
                    checked={filtered.every((i) => effectiveSel.has(`${i.type}.${i.member}`))}
                    onChange={(e) => {
                      const keys = filtered.map((i) => `${i.type}.${i.member}`);
                      setSelection(e.target.checked ? new Set([...effectiveSel, ...keys]) : new Set());
                    }}
                  />
                </th>
                <th>Component</th>
                <th>Type</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((item) => {
                const key = `${item.type}.${item.member}`;
                const checked = effectiveSel.has(key);
                return (
                  <tr key={key}>
                    <td>
                      <input
                        type="checkbox"
                        className="cbx"
                        checked={checked}
                        onChange={() => toggleRow(key)}
                      />
                    </td>
                    <td>
                      <button
                        className="td-name"
                        style={{ background: 'none', border: 'none', color: 'var(--fg-brand)', cursor: 'pointer', padding: 0, fontSize: 'inherit', fontWeight: 500 }}
                        onClick={() => onSelect?.(item)}
                      >
                        {item.member}
                      </button>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)' }}>
                        {item.type}
                      </span>
                    </td>
                    <td><StatusBadge status={item.status} /></td>
                  </tr>
                );
              })}
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
