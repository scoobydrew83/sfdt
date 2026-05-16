import { useState, useEffect } from 'react';
import { api } from '../../api.js';
import HorizontalStepper, { STEPS } from './HorizontalStepper.jsx';
import ContextBar from './ContextBar.jsx';
import ManifestStep from './ManifestStep.jsx';
import ChangelogStep from './ChangelogStep.jsx';
import ReleaseNotesStep from './ReleaseNotesStep.jsx';
import ValidateStep from './ValidateStep.jsx';
import DeployStep from './DeployStep.jsx';
import RollbackStep from './RollbackStep.jsx';
export default function ReleaseHubPage() {
  const [activeStep, setActiveStep]       = useState('manifest');
  const [done, setDone]                   = useState(new Set());
  const [selectedManifest, setSelectedManifest] = useState(null);
  const [aiAvailable, setAiAvailable]     = useState(false);
  const [deployMode, setDeployMode]       = useState('manifest');
  const [selectedSourceDir, setSelectedSourceDir] = useState('');
  useEffect(() => {
    api.aiAvailable().then((d) => setAiAvailable(d.available)).catch(() => {});
  }, []);
  const markDone = (stepId) => {
    setDone((prev) => new Set([...prev, stepId]));
    const idx = STEPS.findIndex((s) => s.id === stepId);
    if (idx < STEPS.length - 1) setActiveStep(STEPS[idx + 1].id);
  };
  const renderStep = () => {
    switch (activeStep) {
      case 'manifest':
        return (
          <ManifestStep
            selected={selectedManifest}
            onSelect={setSelectedManifest}
            deployMode={deployMode}
            setDeployMode={setDeployMode}
            selectedSourceDir={selectedSourceDir}
            setSelectedSourceDir={setSelectedSourceDir}
            onMarkDone={() => {
              if (deployMode === 'folder' ? selectedSourceDir : selectedManifest) markDone('manifest');
            }}
          />
        );
      case 'changelog':
        return <ChangelogStep aiAvailable={aiAvailable} onMarkDone={() => markDone('changelog')} />;
      case 'notes':
        return <ReleaseNotesStep aiAvailable={aiAvailable} onMarkDone={() => markDone('notes')} />;
      case 'validate':
        return <ValidateStep onMarkDone={() => markDone('validate')} />;
      case 'deploy':
        return <DeployStep
          manifest={deployMode === 'folder' ? null : selectedManifest}
          sourceDir={deployMode === 'folder' ? selectedSourceDir : undefined}
          onMarkDone={() => markDone('deploy')}
        />;
      case 'rollback':
        return <RollbackStep />;
      default:
        return null;
    }
  };
  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Release Hub</h1>
          <p className="page-subtitle">Manage manifests, changelog, validation, and deployment</p>
        </div>
      </div>
      <HorizontalStepper active={activeStep} done={done} onSelect={setActiveStep} />
      <div style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        minHeight: 520,
      }}>
        {activeStep !== 'manifest' && <ContextBar manifest={selectedManifest} />}
        <div style={{ overflow: 'auto' }}>
          {renderStep()}
        </div>
      </div>
    </div>
  );
}
