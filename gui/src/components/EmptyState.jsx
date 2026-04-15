import React from 'react';
import Icon from '@salesforce/design-system-react/components/icon';

export default function EmptyState({ title, message }) {
  return (
    <div className="slds-text-align_center slds-p-vertical_xx-large">
      <div className="slds-m-bottom_medium">
        <Icon
          assistiveText={{ label: title ?? 'No data' }}
          category="utility"
          name="table"
          size="large"
          style={{ fill: '#b0adab' }}
        />
      </div>
      <h3 className="slds-text-heading_medium slds-m-bottom_small">
        {title ?? 'No data yet'}
      </h3>
      <p className="slds-text-body_regular slds-text-color_weak">
        {message ?? 'Run a command to see results here.'}
      </p>
    </div>
  );
}
