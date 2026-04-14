import React, { useState, useEffect } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Icon from '@salesforce/design-system-react/components/icon';
import Card from '@salesforce/design-system-react/components/card';
import DataTable from '@salesforce/design-system-react/components/data-table';
import DataTableColumn from '@salesforce/design-system-react/components/data-table/column';
import DataTableCell from '@salesforce/design-system-react/components/data-table/cell';
import Badge from '@salesforce/design-system-react/components/badge';
import Spinner from '@salesforce/design-system-react/components/spinner';
import { api } from '../api.js';
import StatusBadge from '../components/StatusBadge.jsx';
import EmptyState from '../components/EmptyState.jsx';

const STATUS_ICON = {
  pass:    { name: 'check',   color: '#2e844a' },
  passed:  { name: 'check',   color: '#2e844a' },
  success: { name: 'check',   color: '#2e844a' },
  fail:    { name: 'error',   color: '#ba0517' },
  failed:  { name: 'error',   color: '#ba0517' },
  error:   { name: 'error',   color: '#ba0517' },
  warn:    { name: 'warning', color: '#dd7a01' },
  warning: { name: 'warning', color: '#dd7a01' },
};

const CheckNameCell = ({ item }) => {
  const cfg = STATUS_ICON[item.status?.toLowerCase()] ?? { name: 'info', color: '#706e6b' };
  return (
    <span className="slds-media slds-media_center slds-media_small">
      <span className="slds-media__figure">
        <Icon
          assistiveText={{ label: item.status }}
          category="utility"
          name={cfg.name}
          size="x-small"
          style={{ fill: cfg.color }}
        />
      </span>
      <span className="slds-media__body slds-text-body_regular">{item.name}</span>
    </span>
  );
};
CheckNameCell.displayName = DataTableCell.displayName;

const MessageCell = ({ item }) => (
  <span className="slds-text-body_small slds-text-color_weak">{item.message || '—'}</span>
);
MessageCell.displayName = DataTableCell.displayName;

const StatusBadgeCell = ({ item }) => <StatusBadge status={item.status} />;
StatusBadgeCell.displayName = DataTableCell.displayName;

export default function PreflightPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.preflight()
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, []);

  const checks       = data?.checks ?? [];
  const passedCount  = checks.filter((c) => c.status === 'pass' || c.status === 'success').length;
  const failedCount  = checks.filter((c) => c.status === 'fail' || c.status === 'error').length;
  const overallStatus = data?.status;

  const rows = checks.map((c, i) => ({
    id:      String(i),
    name:    c.name,
    message: c.message ?? '',
    status:  c.status,
  }));

  const infoText = data?.date
    ? `Last run: ${new Date(data.date).toLocaleString()}`
    : 'Results of the last sfdt preflight run';

  return (
    <div>
      <PageHeader
        title="Preflight Check"
        label="SFDT"
        info={infoText}
        variant="object-home"
        icon={
          <Icon
            assistiveText={{ label: 'Preflight' }}
            category="utility"
            name="check"
            size="large"
          />
        }
        onRenderActions={() =>
          overallStatus ? (
            <div className="slds-page-header__control">
              <StatusBadge status={overallStatus} />
            </div>
          ) : null
        }
      />

      <div className="slds-p-around_large">
        {loading && (
          <div style={{ position: 'relative', height: '200px' }}>
            <Spinner size="large" variant="brand" />
          </div>
        )}

        {!loading && checks.length === 0 && (
          <EmptyState
            title="No preflight data"
            message="Run sfdt preflight to generate a report that will appear here."
          />
        )}

        {!loading && checks.length > 0 && (
          <Card
            heading={`${checks.length} Check${checks.length !== 1 ? 's' : ''}`}
            icon={
              <Icon
                assistiveText={{ label: 'Checks' }}
                category="utility"
                name="checklist"
                size="small"
              />
            }
            headerActions={
              <div className="slds-grid slds-grid_vertical-align-center">
                {passedCount > 0 && (
                  <Badge
                    content={`${passedCount} passed`}
                    color="success"
                    className="slds-m-right_xx-small"
                  />
                )}
                {failedCount > 0 && (
                  <Badge content={`${failedCount} failed`} color="error" />
                )}
              </div>
            }
          >
            <DataTable items={rows} id="preflight-checks-table">
              <DataTableColumn label="Check" property="name">
                <CheckNameCell />
              </DataTableColumn>
              <DataTableColumn label="Message" property="message">
                <MessageCell />
              </DataTableColumn>
              <DataTableColumn label="Status" property="status">
                <StatusBadgeCell />
              </DataTableColumn>
            </DataTable>
          </Card>
        )}
      </div>
    </div>
  );
}
