import Card from '@salesforce/design-system-react/components/card';
import Icon from '@salesforce/design-system-react/components/icon';

export default function StatCard({ label, value, sub, accent = '#0176d3', iconName = 'info' }) {
  return (
    <Card
      style={{ borderTop: `4px solid ${accent}`, flex: '1 1 150px' }}
      bodyClassName="slds-p-horizontal_medium slds-p-bottom_small"
      heading={label}
      icon={
        <Icon
          assistiveText={{ label }}
          category="utility"
          name={iconName}
          size="small"
        />
      }
    >
      <p className="slds-text-heading_large slds-m-bottom_xx-small">{value ?? '—'}</p>
      {sub && (
        <p className="slds-text-body_small slds-text-color_weak">{sub}</p>
      )}
    </Card>
  );
}
