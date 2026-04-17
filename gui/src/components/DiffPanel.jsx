import React, { useState, useEffect } from 'react';
import Tabs from '@salesforce/design-system-react/components/tabs';
import TabsPanel from '@salesforce/design-system-react/components/tabs/panel';
import Spinner from '@salesforce/design-system-react/components/spinner';
import Button from '@salesforce/design-system-react/components/button';
import { api } from '../api.js';

/**
 * Side-by-side XML diff panel for a single component.
 * @param {{ item: {type, member} | null, onClose: () => void }} props
 */
export default function DiffPanel({ item, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!item) { setData(null); return; }
    setLoading(true);
    api.compareDiff(item.type, item.member)
      .then(setData)
      .catch(() => setData({ sourceXml: '', targetXml: '' }))
      .finally(() => setLoading(false));
  }, [item?.type, item?.member]);

  if (!item) return null;

  return (
    <div
      style={{
        position: 'fixed',
        right: 0,
        top: 0,
        bottom: 0,
        width: '55vw',
        background: '#fff',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
        zIndex: 9000,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        className="slds-p-around_medium slds-grid slds-grid_align-spread"
        style={{ borderBottom: '1px solid #e0e0e0', flexShrink: 0 }}
      >
        <div>
          <p className="slds-text-heading_small">{item.member}</p>
          <p className="slds-text-body_small slds-text-color_weak">{item.type}</p>
        </div>
        <Button
          assistiveText={{ icon: 'Close' }}
          iconCategory="utility"
          iconName="close"
          iconVariant="bare"
          variant="icon"
          onClick={onClose}
        />
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflow: 'auto', padding: '16px' }}>
        {loading && (
          <div style={{ position: 'relative', height: '200px' }}>
            <Spinner size="medium" variant="brand" />
          </div>
        )}

        {!loading && data && (
          <Tabs id="diff-tabs">
            <TabsPanel label="Source">
              <pre
                style={{
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background: '#f8f8f8',
                  padding: '12px',
                  borderRadius: '4px',
                }}
              >
                {data.sourceXml || '(empty)'}
              </pre>
            </TabsPanel>
            <TabsPanel label="Target">
              <pre
                style={{
                  fontSize: '12px',
                  fontFamily: 'monospace',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-all',
                  background: '#f8f8f8',
                  padding: '12px',
                  borderRadius: '4px',
                }}
              >
                {data.targetXml || '(empty)'}
              </pre>
            </TabsPanel>
            <TabsPanel label="Diff">
              {renderLineDiff(data.sourceXml ?? '', data.targetXml ?? '')}
            </TabsPanel>
          </Tabs>
        )}
      </div>
    </div>
  );
}

function renderLineDiff(sourceXml, targetXml) {
  const sourceLines = sourceXml.split('\n');
  const targetLines = targetXml.split('\n');
  const maxLen = Math.max(sourceLines.length, targetLines.length);

  const lines = [];
  for (let i = 0; i < maxLen; i++) {
    const s = sourceLines[i] ?? '';
    const t = targetLines[i] ?? '';
    const changed = s !== t;
    lines.push(
      <div
        key={i}
        style={{
          fontFamily: 'monospace',
          fontSize: '12px',
          whiteSpace: 'pre',
          background: changed ? '#fff3cd' : 'transparent',
          padding: '1px 8px',
        }}
      >
        <span style={{ color: '#aaa', marginRight: '12px', userSelect: 'none' }}>
          {String(i + 1).padStart(4)}
        </span>
        <span style={{ color: '#c00' }}>{s !== t ? `- ${s}` : `  ${s}`}</span>
        {s !== t && (
          <div style={{ color: '#060' }}>{`+ ${t}`}</div>
        )}
      </div>,
    );
  }

  return (
    <div
      style={{
        background: '#f8f8f8',
        padding: '12px',
        borderRadius: '4px',
        overflow: 'auto',
        maxHeight: '60vh',
      }}
    >
      {lines.length === 0 ? <span style={{ color: '#aaa' }}>No diff</span> : lines}
    </div>
  );
}
