import { useState, useEffect, useRef } from 'react';
import { api, stream } from '../api.js';
import CommandRunner from '../components/CommandRunner.jsx';
import StreamRunner from '../components/StreamRunner.jsx';
import {
  IconPackage, IconBook, IconFileEdit, IconShield, IconRocket, IconRotateCcw,
  IconCheck, IconDownload, IconZap,
} from '../Icons.jsx';

// ─── Step definitions ────────────────────────────────────────────────────────

const STEPS = [
  { id: 'manifest',  label: 'Manifest',      Icon: IconPackage  },
  { id: 'changelog', label: 'Changelog',      Icon: IconBook     },
  { id: 'notes',     label: 'Release Notes',  Icon: IconFileEdit },
  { id: 'validate',  label: 'Validate',       Icon: IconShield   },
  { id: 'deploy',    label: 'Deploy',         Icon: IconRocket   },
  { id: 'rollback',  label: 'Rollback',       Icon: IconRotateCcw},
];

// ─── Step Rail ───────────────────────────────────────────────────────────────

function StepRail({ active, done, onSelect }) {
  return (
    <div style={{
      width: 192,
      flexShrink: 0,
      borderRight: '1px solid var(--border-subtle)',
      padding: '20px 0',
      background: 'var(--bg-subtle)',
    }}>
      {STEPS.map((step, i) => {
        const isActive = active === step.id;
        const isDone   = done.has(step.id);
        return (
          <button
            key={step.id}
            onClick={() => onSelect(step.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              width: '100%',
              padding: '9px 16px',
              background: isActive ? 'var(--bg-surface)' : 'transparent',
              borderLeft: isActive ? '3px solid var(--brand-500)' : '3px solid transparent',
              border: 'none',
              borderRadius: 0,
              cursor: 'pointer',
              textAlign: 'left',
              color: isActive ? 'var(--fg-default)' : 'var(--fg-muted)',
              fontSize: 13,
              fontWeight: isActive ? 600 : 400,
            }}
          >
            <span style={{
              width: 20, height: 20,
              borderRadius: '50%',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: isDone ? '#22c55e1a' : isActive ? 'var(--brand-50)' : 'var(--bg-muted)',
              color: isDone ? '#16a34a' : isActive ? 'var(--brand-500)' : 'var(--fg-subtle)',
              flexShrink: 0,
            }}>
              {isDone ? <IconCheck size={11} /> : <step.Icon size={11} />}
            </span>
            <span style={{ fontSize: 12, lineHeight: '1.3' }}>
              <span style={{ display: 'block', fontWeight: isActive ? 600 : 500 }}>{step.label}</span>
              <span style={{ fontSize: 10, color: isDone ? '#16a34a' : 'var(--fg-subtle)' }}>
                {isDone ? 'Done' : isActive ? 'Active' : `Step ${i + 1}`}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─── Context Bar ─────────────────────────────────────────────────────────────

function ContextBar({ manifest }) {
  if (!manifest) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '7px 16px',
      background: 'var(--brand-50)',
      borderBottom: '1px solid var(--brand-100)',
      fontSize: 12,
      color: 'var(--fg-muted)',
    }}>
      <IconPackage size={12} style={{ color: 'var(--brand-500)' }} />
      <span style={{ color: 'var(--fg-default)', fontWeight: 500 }}>{manifest.name}</span>
      <span style={{ color: 'var(--fg-subtle)' }}>·</span>
      <span style={{ color: 'var(--fg-subtle)', fontSize: 11 }}>{manifest.source}</span>
    </div>
  );
}

// ─── Manifest Step ───────────────────────────────────────────────────────────

function ManifestStep({ onSelect, selected, onMarkDone }) {
  const [manifests, setManifests] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [base, setBase]           = useState('main');
  const [head, setHead]           = useState('HEAD');
  const [building, setBuilding]   = useState(false);
  const [buildResult, setBuildResult] = useState(null);

  useEffect(() => {
    api.listManifests()
      .then((d) => setManifests(d.manifests ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const buildFromGit = async () => {
    setBuilding(true);
    setBuildResult(null);
    try {
      const res = await api.buildManifestFromGit(base, head);
      setBuildResult(res);
      // Refresh list
      const d = await api.listManifests();
      setManifests(d.manifests ?? []);
    } catch (err) {
      setBuildResult({ error: err.message });
    } finally {
      setBuilding(false);
    }
  };

  const downloadXml = (xml, name) => {
    const blob = new Blob([xml], { type: 'application/xml' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Select Manifest</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Choose a package.xml to use for this release, or generate one from git.
      </p>

      {/* Manifest list */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
          Available Manifests
        </div>
        {loading && <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
        {!loading && manifests.length === 0 && (
          <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>
            No manifests found. Generate one from git or run a Compare first.
          </div>
        )}
        {manifests.map((m) => (
          <button
            key={m.relPath}
            onClick={() => onSelect(m)}
            style={{
              display: 'flex', alignItems: 'center', gap: 10,
              width: '100%', padding: '9px 14px',
              background: selected?.relPath === m.relPath ? 'var(--brand-50)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border-subtle)',
              cursor: 'pointer',
              textAlign: 'left',
              borderLeft: selected?.relPath === m.relPath ? '3px solid var(--brand-500)' : '3px solid transparent',
            }}
          >
            <IconPackage size={13} style={{ color: selected?.relPath === m.relPath ? 'var(--brand-500)' : 'var(--fg-muted)', flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-default)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {m.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                {m.source} · {new Date(m.date).toLocaleDateString()}
              </div>
            </div>
            {selected?.relPath === m.relPath && (
              <IconCheck size={12} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
            )}
          </button>
        ))}
      </div>

      {/* Generate from git */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
          Generate from Git Diff
        </div>
        <div style={{ padding: '12px 14px' }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Base</label>
              <input className="input" style={{ fontSize: 12 }} value={base} onChange={(e) => setBase(e.target.value)} placeholder="main" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Head</label>
              <input className="input" style={{ fontSize: 12 }} value={head} onChange={(e) => setHead(e.target.value)} placeholder="HEAD" />
            </div>
          </div>
          <button className="btn btn-primary btn-sm" onClick={buildFromGit} disabled={building}>
            {building ? <><div className="live-dot" style={{ marginRight: 4 }} />Generating…</> : <><IconZap size={11} /> Generate</>}
          </button>
          {buildResult?.error && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--status-conflict-fg)' }}>Error: {buildResult.error}</div>
          )}
          {buildResult && !buildResult.error && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
              Generated <strong style={{ color: 'var(--fg-default)' }}>{buildResult.filename}</strong>
              {' '}({buildResult.addCount} components)
              <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={() => downloadXml(buildResult.xml, buildResult.filename)}>
                <IconDownload size={11} /> Download
              </button>
            </div>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn btn-primary"
          onClick={onMarkDone}
          disabled={!selected}
        >
          Continue with {selected ? selected.name : '…'} →
        </button>
      </div>
    </div>
  );
}

// ─── Changelog Step ──────────────────────────────────────────────────────────

function ChangelogStep({ aiAvailable, onMarkDone }) {
  const [content, setContent]     = useState('');
  const [loading, setLoading]     = useState(true);
  const [generating, setGenerating] = useState(false);
  const [genLines, setGenLines]   = useState([]);
  const counterRef = useRef(0);

  useEffect(() => {
    api.changelogContent()
      .then((d) => setContent(d.content ?? ''))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const generate = () => {
    setGenerating(true);
    setGenLines([]);
    counterRef.current = 0;
    const s = stream.changelogGenerate();
    s.onmessage = ({ data: msg }) => {
      if (msg.type === 'log') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        if (msg.content) setContent(msg.content);
        setGenerating(false);
      } else if (msg.type === 'error') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: `Error: ${msg.message}` }]);
        setGenerating(false);
      }
    };
    s.onerror = () => setGenerating(false);
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Changelog</h2>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Review and edit the [Unreleased] section of CHANGELOG.md
          </p>
        </div>
        {aiAvailable && (
          <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
            {generating ? <><div className="live-dot" style={{ marginRight: 4 }} />Generating…</> : <><IconZap size={11} /> Generate with AI</>}
          </button>
        )}
      </div>

      {loading && <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Loading CHANGELOG.md…</div>}

      {!loading && (
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          style={{
            width: '100%',
            height: 260,
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            padding: '10px 12px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-default)',
            borderRadius: 6,
            color: 'var(--fg-default)',
            resize: 'vertical',
            outline: 'none',
            marginBottom: 10,
          }}
          placeholder="### Added&#10;- ...&#10;### Fixed&#10;- ..."
          spellCheck={false}
        />
      )}

      {genLines.length > 0 && (
        <div className="cmd-terminal" style={{ maxHeight: 120, marginBottom: 10 }}>
          {genLines.map(({ id, text }) => (
            <div key={id} className="cmd-line">{text || '\u00A0'}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={onMarkDone}>
          Changelog ready →
        </button>
      </div>
    </div>
  );
}

// ─── Release Notes Step ──────────────────────────────────────────────────────

function ReleaseNotesStep({ aiAvailable, onMarkDone }) {
  const [content, setContent]     = useState('');
  const [generating, setGenerating] = useState(false);
  const [genLines, setGenLines]   = useState([]);
  const counterRef = useRef(0);

  const generate = () => {
    setGenerating(true);
    setGenLines([]);
    counterRef.current = 0;
    const s = stream.releaseNotes();
    s.onmessage = ({ data: msg }) => {
      if (msg.type === 'log') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        if (msg.content) setContent(msg.content);
        setGenerating(false);
      } else if (msg.type === 'error') {
        const id = counterRef.current++;
        setGenLines((prev) => [...prev, { id, text: `Error: ${msg.message}` }]);
        setGenerating(false);
      }
    };
    s.onerror = () => setGenerating(false);
  };

  return (
    <div style={{ padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Release Notes</h2>
          <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
            Draft stakeholder-facing release notes (Markdown)
          </p>
        </div>
        {aiAvailable && (
          <button className="btn btn-primary btn-sm" onClick={generate} disabled={generating}>
            {generating ? <><div className="live-dot" style={{ marginRight: 4 }} />Generating…</> : <><IconZap size={11} /> Generate with AI</>}
          </button>
        )}
      </div>

      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        style={{
          width: '100%',
          height: 300,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          padding: '10px 12px',
          background: 'var(--bg-subtle)',
          border: '1px solid var(--border-default)',
          borderRadius: 6,
          color: 'var(--fg-default)',
          resize: 'vertical',
          outline: 'none',
          marginBottom: 10,
        }}
        placeholder="## Overview&#10;&#10;## What's New&#10;&#10;## Bug Fixes"
        spellCheck={false}
      />

      {genLines.length > 0 && (
        <div className="cmd-terminal" style={{ maxHeight: 120, marginBottom: 10 }}>
          {genLines.map(({ id, text }) => (
            <div key={id} className="cmd-line">{text || '\u00A0'}</div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button className="btn btn-primary" onClick={onMarkDone}>
          Notes ready →
        </button>
      </div>
    </div>
  );
}

// ─── Validate Step ───────────────────────────────────────────────────────────

function ValidateStep({ onMarkDone }) {
  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Validate</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Run preflight checks to verify the org is ready for deployment.
      </p>
      <CommandRunner
        command="preflight"
        label="Preflight Checks"
        onComplete={onMarkDone}
      />
    </div>
  );
}

// ─── Deploy Step ─────────────────────────────────────────────────────────────

const DEPLOY_OPTIONS = [
  {
    id:      'standard',
    label:   'Deploy',
    desc:    'Full deployment with preflight',
    opts:    { dryRun: false, skipPreflight: false, notifySlack: false },
  },
  {
    id:      'dry-run',
    label:   'Dry Run',
    desc:    'Validate without deploying',
    opts:    { dryRun: true,  skipPreflight: false, notifySlack: false },
  },
  {
    id:      'skip-preflight',
    label:   'Skip Preflight',
    desc:    'Deploy fast, skip checks',
    opts:    { dryRun: false, skipPreflight: true,  notifySlack: false },
  },
  {
    id:      'notify',
    label:   'Deploy + Notify',
    desc:    'Deploy and send Slack notification',
    opts:    { dryRun: false, skipPreflight: false, notifySlack: true  },
  },
];

function DeployStep({ manifest, onMarkDone }) {
  const [selected, setSelected] = useState('standard');
  const [streamKey, setStreamKey] = useState(0);

  const option = DEPLOY_OPTIONS.find((o) => o.id === selected);
  const cliPreview = [
    'sfdt deploy',
    option?.opts.dryRun        ? '--dry-run'        : '',
    option?.opts.skipPreflight ? '--skip-preflight' : '',
    option?.opts.notifySlack   ? '--notify'         : '',
    manifest ? `--manifest ${manifest.relPath}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Deploy</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Choose a deployment mode and run it.
      </p>

      {/* Option cards */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 16 }}>
        {DEPLOY_OPTIONS.map((opt) => (
          <button
            key={opt.id}
            onClick={() => { setSelected(opt.id); setStreamKey((k) => k + 1); }}
            style={{
              padding: '12px 14px',
              background: selected === opt.id ? 'var(--brand-50)' : 'var(--bg-subtle)',
              border: `1px solid ${selected === opt.id ? 'var(--brand-300)' : 'var(--border-subtle)'}`,
              borderRadius: 8,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: selected === opt.id ? 'var(--brand-700)' : 'var(--fg-default)', marginBottom: 3 }}>
              {opt.label}
            </div>
            <div style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{opt.desc}</div>
          </button>
        ))}
      </div>

      {/* CLI preview */}
      <div style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        padding: '7px 12px',
        background: 'var(--bg-subtle)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 6,
        color: 'var(--fg-muted)',
        marginBottom: 16,
      }}>
        $ {cliPreview}
      </div>

      <StreamRunner
        key={streamKey}
        label={`${option?.label ?? 'Deploy'} to org`}
        startLabel={option?.label ?? 'Deploy'}
        streamFn={() => stream.deploy({ ...option?.opts, manifest: manifest?.relPath })}
        onComplete={onMarkDone}
      />
    </div>
  );
}

// ─── Rollback Step ───────────────────────────────────────────────────────────

function RollbackStep() {
  const [history, setHistory]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [streamKey, setStreamKey]     = useState(0);

  useEffect(() => {
    api.deployHistory()
      .then((d) => setHistory(d.history ?? []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Rollback</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Roll back the org to a previous deployment.
      </p>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-head" style={{ padding: '10px 14px', fontSize: 12, fontWeight: 600 }}>
          Deployment History
        </div>
        {loading && <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>}
        {!loading && history.length === 0 && (
          <div style={{ padding: 14, color: 'var(--fg-muted)', fontSize: 12 }}>
            No deployment history found. Deployments made via the GUI will appear here.
          </div>
        )}
        {history.map((entry, i) => (
          <button
            key={i}
            onClick={() => { setSelectedEntry(entry); setStreamKey((k) => k + 1); }}
            style={{
              display: 'flex', alignItems: 'center', gap: 12,
              width: '100%', padding: '10px 14px',
              background: selectedEntry === entry ? 'var(--brand-50)' : 'transparent',
              border: 'none',
              borderBottom: '1px solid var(--border-subtle)',
              borderLeft: selectedEntry === entry ? '3px solid var(--brand-500)' : '3px solid transparent',
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <span style={{
              width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
              background: entry.exitCode === 0 ? '#22c55e' : '#ef4444',
            }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--fg-default)' }}>
                {entry.manifest ?? 'Unknown manifest'}
                {entry.dryRun && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--fg-subtle)' }}>dry-run</span>}
              </div>
              <div style={{ fontSize: 11, color: 'var(--fg-subtle)' }}>
                {entry.org ?? 'default org'} · {new Date(entry.date).toLocaleString()}
              </div>
            </div>
            {selectedEntry === entry && <IconCheck size={12} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />}
          </button>
        ))}
      </div>

      <StreamRunner
        key={streamKey}
        label="Rollback deployment"
        startLabel="Roll Back"
        streamFn={selectedEntry ? () => stream.deploy({
          manifest: selectedEntry.manifest,
          org: selectedEntry.org,
          dryRun: false,
          skipPreflight: false,
          notifySlack: false,
        }) : null}
      />

      {!selectedEntry && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
          Select a deployment from history above to enable rollback.
        </div>
      )}
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────

export default function ReleaseHubPage() {
  const [activeStep, setActiveStep]       = useState('manifest');
  const [done, setDone]                   = useState(new Set());
  const [selectedManifest, setSelectedManifest] = useState(null);
  const [aiAvailable, setAiAvailable]     = useState(false);

  useEffect(() => {
    api.aiAvailable().then((d) => setAiAvailable(d.available)).catch(() => {});
  }, []);

  const markDone = (stepId) => {
    setDone((prev) => new Set([...prev, stepId]));
    // Advance to next step
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
            onMarkDone={() => {
              if (selectedManifest) markDone('manifest');
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
        return <DeployStep manifest={selectedManifest} onMarkDone={() => markDone('deploy')} />;
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

      <div style={{
        display: 'flex',
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 8,
        overflow: 'hidden',
        minHeight: 520,
      }}>
        <StepRail active={activeStep} done={done} onSelect={setActiveStep} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          {activeStep !== 'manifest' && <ContextBar manifest={selectedManifest} />}
          <div style={{ flex: 1, overflow: 'auto' }}>
            {renderStep()}
          </div>
        </div>
      </div>
    </div>
  );
}
