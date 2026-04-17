import React, { useState, useEffect, useRef } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Icon from '@salesforce/design-system-react/components/icon';
import Card from '@salesforce/design-system-react/components/card';
import Button from '@salesforce/design-system-react/components/button';
import Combobox from '@salesforce/design-system-react/components/combobox';
import ProgressBar from '@salesforce/design-system-react/components/progress-bar';
import Spinner from '@salesforce/design-system-react/components/spinner';
import Modal from '@salesforce/design-system-react/components/modal';
import { api } from '../api.js';
import CompareTable from '../components/CompareTable.jsx';
import DiffPanel from '../components/DiffPanel.jsx';
import EmptyState from '../components/EmptyState.jsx';

const LOCAL_OPTION = { id: 'local', label: 'Local Source' };

export default function ComparePage() {
  const [orgs, setOrgs]               = useState([]);
  const [source, setSource]           = useState(LOCAL_OPTION);
  const [target, setTarget]           = useState(null);
  const [running, setRunning]         = useState(false);
  const [items, setItems]             = useState([]);
  const [hasResult, setHasResult]     = useState(false);
  const [phase2Total, setPhase2Total] = useState(0);
  const [phase2Done, setPhase2Done]   = useState(0);
  const [phase2Active, setPhase2Active] = useState(false);
  const [diffItem, setDiffItem]       = useState(null);
  const [manifest, setManifest]       = useState(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => setOrgs(list ?? []))
      .catch(() => {});
  }, []);

  const orgOptions = [LOCAL_OPTION, ...orgs.map((o) => ({ id: o.alias, label: o.alias }))];

  const startPhase2 = () => {
    if (esRef.current) esRef.current.close();
    setPhase2Active(true);
    setPhase2Done(0);

    const es = new EventSource('/api/compare/stream');
    esRef.current = es;

    es.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'progress') {
        setPhase2Total(event.total);
        setPhase2Done(event.completed);
      } else if (event.type === 'diff') {
        setItems((prev) =>
          prev.map((i) =>
            i.type === event.itemType && i.member === event.member
              ? { ...i, status: event.status }
              : i,
          ),
        );
      } else if (event.type === 'done') {
        setPhase2Active(false);
        es.close();
      }
    };
    es.onerror = () => {
      setPhase2Active(false);
      es.close();
    };
  };

  const handleRunCompare = async () => {
    if (!target) return;
    setRunning(true);
    setItems([]);
    setHasResult(false);
    setPhase2Active(false);
    try {
      const result = await api.runCompare(source.id, target.id);
      setItems(result.items ?? []);
      setHasResult(true);
      const hasBoth = (result.items ?? []).some((i) => i.status === 'both');
      if (hasBoth) startPhase2();
    } catch (err) {
      console.error('Compare failed', err);
    } finally {
      setRunning(false);
    }
  };

  const handleBuildManifest = async (selected) => {
    try {
      const { xml } = await api.buildManifest(
        selected.map(({ type, member }) => ({ type, member })),
      );
      setManifest(xml);
      setManifestOpen(true);
    } catch (err) {
      console.error('Manifest build failed', err);
    }
  };

  const phase2Pct = phase2Total > 0 ? Math.round((phase2Done / phase2Total) * 100) : 0;

  return (
    <div>
      <PageHeader
        title="Org Comparison"
        label="SFDT"
        info="Compare metadata between two orgs or local source vs an org"
        variant="object-home"
        icon={
          <Icon
            assistiveText={{ label: 'Compare' }}
            category="utility"
            name="connected_apps"
            size="large"
          />
        }
      />

      <div className="slds-p-around_large">

        {/* Source / Target selector */}
        <Card
          heading="Select Sources"
          icon={<Icon assistiveText={{ label: 'Settings' }} category="utility" name="settings" size="small" />}
          className="slds-m-bottom_medium"
        >
          <div className="slds-card__body_inner">
            <div className="slds-grid slds-gutters slds-grid_vertical-align-end">
              <div className="slds-col slds-size_1-of-3">
                <Combobox
                  id="source-select"
                  labels={{ label: 'Source', placeholder: 'Select source…' }}
                  options={orgOptions}
                  selection={source ? [source] : []}
                  onSelect={(e, { selection: sel }) => setSource(sel[0] ?? null)}
                  variant="readonly"
                />
              </div>
              <div className="slds-col slds-no-flex slds-p-bottom_x-small slds-text-heading_medium slds-text-color_weak">
                →
              </div>
              <div className="slds-col slds-size_1-of-3">
                <Combobox
                  id="target-select"
                  labels={{ label: 'Target', placeholder: 'Select target org…' }}
                  options={orgs.map((o) => ({ id: o.alias, label: o.alias }))}
                  selection={target ? [target] : []}
                  onSelect={(e, { selection: sel }) => setTarget(sel[0] ?? null)}
                  variant="readonly"
                />
              </div>
              <div className="slds-col slds-no-flex">
                <Button
                  label={running ? 'Running…' : 'Run Comparison'}
                  variant="brand"
                  disabled={!source || !target || running}
                  onClick={handleRunCompare}
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Phase 2 progress bar */}
        {phase2Active && (
          <div className="slds-m-bottom_medium">
            <p className="slds-text-body_small slds-m-bottom_xx-small slds-text-color_weak">
              {`Comparing content for shared components… ${phase2Done}/${phase2Total}`}
            </p>
            <ProgressBar value={phase2Pct} variant="circular" />
          </div>
        )}

        {/* Loading spinner during Phase 1 */}
        {running && (
          <div style={{ position: 'relative', height: '200px' }}>
            <Spinner size="large" variant="brand" />
          </div>
        )}

        {/* Empty state before first run */}
        {!running && !hasResult && (
          <EmptyState
            title="No comparison yet"
            message="Select a source and target above, then click Run Comparison."
          />
        )}

        {/* Results */}
        {!running && hasResult && (
          <Card
            heading="Comparison Results"
            icon={<Icon assistiveText={{ label: 'Results' }} category="utility" name="table" size="small" />}
          >
            <div className="slds-card__body_inner">
              <CompareTable
                items={items}
                onSelect={setDiffItem}
                onBuildManifest={handleBuildManifest}
              />
            </div>
          </Card>
        )}
      </div>

      {/* Diff panel */}
      <DiffPanel item={diffItem} onClose={() => setDiffItem(null)} />

      {/* Manifest modal */}
      {manifestOpen && (
        <Modal
          isOpen={manifestOpen}
          heading="Package.xml Manifest"
          footer={[
            <Button
              key="copy"
              label="Copy"
              onClick={() => navigator.clipboard.writeText(manifest ?? '')}
            />,
            <Button
              key="download"
              label="Download"
              variant="brand"
              onClick={() => {
                const blob = new Blob([manifest ?? ''], { type: 'application/xml' });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'compare-manifest.xml';
                a.click();
                URL.revokeObjectURL(url);
              }}
            />,
            <Button key="close" label="Close" onClick={() => setManifestOpen(false)} />,
          ]}
          onRequestClose={() => setManifestOpen(false)}
        >
          <div className="slds-p-around_medium">
            <pre
              style={{
                fontSize: '12px',
                fontFamily: 'monospace',
                whiteSpace: 'pre-wrap',
                maxHeight: '60vh',
                overflow: 'auto',
                background: '#f8f8f8',
                padding: '12px',
                borderRadius: '4px',
              }}
            >
              {manifest}
            </pre>
          </div>
        </Modal>
      )}
    </div>
  );
}
