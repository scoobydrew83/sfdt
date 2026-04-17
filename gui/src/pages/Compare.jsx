import { useState, useEffect, useRef, useMemo } from 'react';
import PageHeader from '@salesforce/design-system-react/components/page-header';
import Icon from '@salesforce/design-system-react/components/icon';
import Card from '@salesforce/design-system-react/components/card';
import Button from '@salesforce/design-system-react/components/button';
import Combobox from '@salesforce/design-system-react/components/combobox';
import ProgressBar from '@salesforce/design-system-react/components/progress-bar';
import Spinner from '@salesforce/design-system-react/components/spinner';
import Modal from '@salesforce/design-system-react/components/modal';
import Alert from '@salesforce/design-system-react/components/alert';
import { api } from '../api.js';
import CompareTable from '../components/CompareTable.jsx';
import DiffPanel from '../components/DiffPanel.jsx';
import EmptyState from '../components/EmptyState.jsx';

const LOCAL_OPTION = { id: 'local', label: 'Local Source' };

export default function ComparePage() {
  const [orgs, setOrgs]               = useState([]);
  const [source, setSource]           = useState(LOCAL_OPTION);
  const [sourceInput, setSourceInput] = useState('Local Source');
  const [target, setTarget]           = useState(null);
  const [targetInput, setTargetInput] = useState('');
  const [running, setRunning]         = useState(false);
  const [items, setItems]             = useState([]);
  const [hasResult, setHasResult]     = useState(false);
  const [phase2Total, setPhase2Total] = useState(0);
  const [phase2Done, setPhase2Done]   = useState(0);
  const [phase2Active, setPhase2Active] = useState(false);
  const [streamError, setStreamError] = useState(null);
  const [diffItem, setDiffItem]       = useState(null);
  const [manifest, setManifest]       = useState(null);
  const [manifestOpen, setManifestOpen] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => setOrgs(list ?? []))
      .catch(() => {});
  }, []);

  // Filtered source options based on typed text
  const sourceOptions = useMemo(() => {
    const all = [LOCAL_OPTION, ...orgs.map((o) => ({ id: o.alias, label: o.alias }))];
    if (!sourceInput) return all;
    const q = sourceInput.toLowerCase();
    return all.filter((o) => o.label.toLowerCase().includes(q));
  }, [orgs, sourceInput]);

  // Filtered target options based on typed text
  const targetOptions = useMemo(() => {
    const all = orgs.map((o) => ({ id: o.alias, label: o.alias }));
    if (!targetInput) return all;
    const q = targetInput.toLowerCase();
    return all.filter((o) => o.label.toLowerCase().includes(q));
  }, [orgs, targetInput]);

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
      setStreamError('Streaming failed. The comparison inventory was saved — click Run Comparison again to retry.');
      setPhase2Active(false);
      es.close();
    };
  };

  const handleRunCompare = async () => {
    setStreamError(null);
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
          bodyClassName="slds-p-horizontal_medium slds-p-bottom_small"
        >
            <div className="slds-grid slds-grid_vertical-align-end" style={{ gap: '1rem' }}>

              {/* Source */}
              <div className="slds-col">
                <Combobox
                  id="source-select"
                  labels={{ label: 'Source', placeholder: 'Type "local" or an org alias…' }}
                  options={sourceOptions}
                  selection={[]}
                  value={sourceInput}
                  variant="base"
                  events={{
                    onChange: (_e, { value }) => {
                      setSourceInput(value);
                      setSource(value ? { id: value, label: value } : null);
                    },
                    onSelect: (_e, { selection: sel }) => {
                      if (sel[0]) {
                        setSource(sel[0]);
                        setSourceInput(sel[0].label);
                      }
                    },
                  }}
                />
              </div>

              {/* Arrow */}
              <div className="slds-col slds-no-flex" style={{ paddingBottom: '8px' }}>
                <Icon
                  assistiveText={{ label: 'to' }}
                  category="utility"
                  name="forward"
                  size="x-small"
                  style={{ fill: '#706e6b' }}
                />
              </div>

              {/* Target */}
              <div className="slds-col">
                <Combobox
                  id="target-select"
                  labels={{ label: 'Target Org', placeholder: 'Type target org alias…' }}
                  options={targetOptions}
                  selection={[]}
                  value={targetInput}
                  variant="base"
                  events={{
                    onChange: (_e, { value }) => {
                      setTargetInput(value);
                      setTarget(value ? { id: value, label: value } : null);
                    },
                    onSelect: (_e, { selection: sel }) => {
                      if (sel[0]) {
                        setTarget(sel[0]);
                        setTargetInput(sel[0].label);
                      }
                    },
                  }}
                />
              </div>

              {/* Run button */}
              <div className="slds-col slds-no-flex slds-shrink-none" style={{ paddingBottom: '2px' }}>
                <Button
                  label={running ? 'Running…' : 'Run Comparison'}
                  variant="brand"
                  disabled={!source || !target || running}
                  onClick={handleRunCompare}
                />
              </div>

            </div>
            <p className="slds-text-body_small slds-text-color_weak slds-m-top_x-small">
              Use <code>local</code> for local source files, or type any Salesforce org alias (e.g. <code>sandbox</code>, <code>production</code>).
            </p>
        </Card>

        {/* Phase 2 progress bar */}
        {phase2Active && (
          <div className="slds-m-bottom_medium">
            <p className="slds-text-body_small slds-m-bottom_xx-small slds-text-color_weak">
              {`Comparing content for shared components… ${phase2Done}/${phase2Total}`}
            </p>
            <ProgressBar value={phase2Pct} />
          </div>
        )}

        {streamError && (
          <Alert
            labels={{ heading: streamError }}
            variant="error"
            className="slds-m-bottom_medium"
            onRequestClose={() => setStreamError(null)}
          />
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
            bodyClassName="slds-p-horizontal_medium slds-p-bottom_small"
          >
            <CompareTable
              items={items}
              onSelect={setDiffItem}
              onBuildManifest={handleBuildManifest}
            />
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
