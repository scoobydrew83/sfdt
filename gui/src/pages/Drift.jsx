import { useState, useEffect } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Icon from '@salesforce/design-system-react/components/icon';
import Card from '@salesforce/design-system-react/components/card';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Spinner from '@salesforce/design-system-react/components/spinner';
import ButtonGroup from '@salesforce/design-system-react/components/button-group';
import Button from '@salesforce/design-system-react/components/button';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CommandRunner from '../components/CommandRunner.jsx';

const DriftStatusCell = ({ item }) => <StatusBadge status={item.drift} />;
DriftStatusCell.displayName = DataTableCell.displayName;

export default function DriftPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    setLoading(true);
    api.drift()
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [refreshKey]);

  const components = data?.components ?? [];
  const filtered   = filter === 'all'
    ? components
    : components.filter((c) => c.drift?.toLowerCase() === filter);

  const rows = filtered.map((c, i) => ({
    id:    String(i),
    name:  c.name  ?? '—',
    type:  c.type  ?? '—',
    drift: c.drift ?? 'unknown',
  }));

  const driftCount = components.filter((c) => c.drift?.toLowerCase() === 'drift').length;
  const cleanCount = components.filter((c) => c.drift?.toLowerCase() === 'clean').length;

  const infoText = data?.date
    ? `Last checked: ${new Date(data.date).toLocaleString()}`
    : 'Metadata drift between local source and target org';

  return (
    <div>
      <PageHeader
        title="Drift Detection"
        label="SFDT"
        info={infoText}
        variant="object-home"
        icon={
          <Icon
            assistiveText={{ label: 'Drift Detection' }}
            category="utility"
            name="refresh"
            size="large"
          />
        }
      />

      <div className="slds-p-around_large">
        <CommandRunner command="drift" label="Drift Check" onComplete={() => setRefreshKey((k) => k + 1)} />

        {components.length > 0 && (
          <div className="slds-m-bottom_medium">
            <ButtonGroup id="drift-filter">
              <Button
                label={`All (${components.length})`}
                variant={filter === 'all' ? 'brand' : 'neutral'}
                onClick={() => setFilter('all')}
              />
              <Button
                label={`Clean (${cleanCount})`}
                variant={filter === 'clean' ? 'success' : 'neutral'}
                onClick={() => setFilter('clean')}
              />
              <Button
                label={`Drift (${driftCount})`}
                variant={filter === 'drift' ? 'destructive' : 'neutral'}
                onClick={() => setFilter('drift')}
              />
            </ButtonGroup>
          </div>
        )}

        {loading && (
          <div style={{ position: 'relative', height: '200px' }}>
            <Spinner size="large" variant="brand" />
          </div>
        )}

        {!loading && components.length === 0 && (
          <EmptyState
            title="No drift data"
            message="Run sfdt drift to compare your local source against the target org."
          />
        )}

        {!loading && components.length > 0 && (
          <Card
            heading="Component Comparison"
            icon={
              <Icon
                assistiveText={{ label: 'Components' }}
                category="utility"
                name="table"
                size="small"
              />
            }
          >
            {rows.length === 0 ? (
              <div className="slds-p-horizontal_medium slds-p-bottom_small slds-text-align_center slds-text-color_weak slds-p-vertical_large">
                No components match the selected filter.
              </div>
            ) : (
              <DataTable items={rows} id="drift-table" striped>
                <DataTableColumn label="Component"   property="name" />
                <DataTableColumn label="Type"        property="type" />
                <DataTableColumn label="Drift Status" property="drift">
                  <DriftStatusCell />
                </DataTableColumn>
              </DataTable>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}
