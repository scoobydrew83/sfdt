import { useState, useMemo } from 'react';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Input from '@salesforce/design-system-react/components/input';
import Combobox from '@salesforce/design-system-react/components/combobox';
import Button from '@salesforce/design-system-react/components/button';
import StatusBadge from './StatusBadge.jsx';

const STATUS_OPTIONS = [
  { id: 'all',         label: 'All Statuses' },
  { id: 'source-only', label: 'Only in Source' },
  { id: 'target-only', label: 'Only in Target' },
  { id: 'modified',    label: 'Modified' },
  { id: 'identical',   label: 'Identical' },
  { id: 'both',        label: 'Checking…' },
];

const StatusCell = ({ item }) => <StatusBadge status={item.status} />;
StatusCell.displayName = DataTableCell.displayName;

// Factory function used to pass onSelect into the cell renderer via closure
function makeMemberCell(onSelect) {
  const MemberCell = ({ item }) => (
    <a
      href="#"
      onClick={(e) => { e.preventDefault(); onSelect?.(item._item); }}
      style={{ color: '#0176d3', textDecoration: 'none' }}
    >
      {item.member}
    </a>
  );
  MemberCell.displayName = DataTableCell.displayName;
  return MemberCell;
}

/**
 * @param {{ items: Array<{type,member,status}>, onSelect: (item) => void, onBuildManifest: (selected) => void }} props
 */
export default function CompareTable({ items = [], onSelect, onBuildManifest }) {
  const [search, setSearch]             = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter]     = useState('all');
  const [selection, setSelection]       = useState(new Set());

  const types = useMemo(() => {
    const t = [...new Set(items.map((i) => i.type))].sort();
    return [{ id: 'all', label: 'All Types' }, ...t.map((x) => ({ id: x, label: x }))];
  }, [items]);

  const filtered = useMemo(() => {
    return items.filter((i) => {
      if (statusFilter !== 'all' && i.status !== statusFilter) return false;
      if (typeFilter !== 'all' && i.type !== typeFilter) return false;
      if (search && !`${i.type}.${i.member}`.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    });
  }, [items, statusFilter, typeFilter, search]);

  const rows = filtered.map((item, idx) => ({
    id:     String(idx),
    type:   item.type,
    member: item.member,
    status: item.status,
    _item:  item,
  }));

  // Pre-select source-only and modified when items first load
  const autoSelectedKeys = useMemo(() => {
    return new Set(
      items
        .filter((i) => i.status === 'source-only' || i.status === 'modified')
        .map((i) => `${i.type}.${i.member}`),
    );
  }, [items]);

  const effectiveSelection = selection.size === 0 ? autoSelectedKeys : selection;

  const MemberCell = useMemo(() => makeMemberCell(onSelect), [onSelect]);

  const handleBuildManifest = () => {
    const selected = items.filter((i) => effectiveSelection.has(`${i.type}.${i.member}`));
    onBuildManifest(selected);
  };

  return (
    <div>
      {/* Toolbar */}
      <div className="slds-grid slds-m-bottom_small slds-wrap" style={{ gap: '1rem' }}>
        <div className="slds-col slds-size_1-of-3">
          <Input
            label=""
            placeholder="Search components…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            iconLeft={{ name: 'search', category: 'utility' }}
          />
        </div>
        <div className="slds-col slds-size_1-of-4">
          <Combobox
            id="status-filter"
            labels={{ label: '', placeholder: 'Status' }}
            options={STATUS_OPTIONS}
            selection={[STATUS_OPTIONS.find((o) => o.id === statusFilter)]}
            onSelect={(_e, { selection: sel }) => setStatusFilter(sel[0]?.id ?? 'all')}
            variant="readonly"
          />
        </div>
        <div className="slds-col slds-size_1-of-4">
          <Combobox
            id="type-filter"
            labels={{ label: '', placeholder: 'Type' }}
            options={types}
            selection={[types.find((t) => t.id === typeFilter)]}
            onSelect={(_e, { selection: sel }) => setTypeFilter(sel[0]?.id ?? 'all')}
            variant="readonly"
          />
        </div>
        <div className="slds-col slds-no-flex">
          <Button
            label={`Build Manifest (${effectiveSelection.size})`}
            variant="brand"
            disabled={effectiveSelection.size === 0}
            onClick={handleBuildManifest}
          />
        </div>
      </div>

      {/* Table */}
      <DataTable
        items={rows}
        id="compare-table"
        striped
        onRowChange={(_e, { selection: sel }) => {
          const keys = sel.map((r) => `${r.type}.${r.member}`);
          setSelection(new Set(keys));
        }}
        selectRows="checkbox"
      >
        <DataTableColumn label="Component" property="member" sortable>
          <MemberCell />
        </DataTableColumn>
        <DataTableColumn label="Type" property="type" sortable />
        <DataTableColumn label="Status" property="status">
          <StatusCell />
        </DataTableColumn>
      </DataTable>

      {/* Summary footer */}
      <div className="slds-text-body_small slds-text-color_weak slds-m-top_small">
        {(() => {
          const counts = { 'source-only': 0, 'target-only': 0, modified: 0, identical: 0, both: 0 };
          for (const i of items) counts[i.status] = (counts[i.status] ?? 0) + 1;
          return `${items.length} total · ${counts['source-only']} only in source · ${counts['target-only']} only in target · ${counts.modified} modified · ${counts.identical} identical · ${counts.both} checking…`;
        })()}
      </div>
    </div>
  );
}
