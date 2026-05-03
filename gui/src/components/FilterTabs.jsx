import React from 'react';

export default function FilterTabs({ tabs = [], active, onChange }) {
  return (
    <div className="filter-tabs" role="tablist">
      {tabs.map(({ label, count, variant }) => {
        const isActive = label === active;
        const variantClass = variant ? ` filter-tab-${variant}` : '';
        return (
          <button
            key={label}
            role="tab"
            aria-selected={isActive}
            className={`filter-tab${variantClass}${isActive ? ' active' : ''}`}
            onClick={() => onChange?.(label)}
          >
            {label}
            <span className="tab-count">{count ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}
