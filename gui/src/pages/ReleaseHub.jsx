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
  const [viewingXml, setViewingXml] = useState(null); // { name, xml, components: [] }

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

  const viewManifest = async (m) => {
    try {
      const { xml } = await api.getManifestContent(m.relPath);
      const parser = new DOMParser();
      const doc = parser.parseFromString(xml, 'application/xml');
      const types = Array.from(doc.querySelectorAll('types'));
      const components = [];
      types.forEach(t => {
        const name = t.querySelector('name')?.textContent;
        const members = Array.from(t.querySelectorAll('members')).map(m => m.textContent);
        members.forEach(member => { components.push({ type: name, member }); });
      });
      setViewingXml({ ...m, xml, components });
    } catch (err) {
      alert(`Could not load manifest: ${err.message}`);
    }
  };

  const removeComponent = async (type, member) => {
    if (!viewingXml) return;
    try {
      await api.removeManifestComponent(viewingXml.relPath, type, member);
      viewManifest(viewingXml);
    } catch (err) {
      alert(`Remove failed: ${err.message}`);
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

      <div style={{ display: 'grid', gridTemplateColumns: viewingXml ? '1fr 380px' : '1fr', gap: 24, alignItems: 'start' }}>
        <div>
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
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-ghost btn-xs" onClick={(e) => { e.stopPropagation(); viewManifest(m); }}>
                <IconSearch size={10} /> View
              </button>
              {selected?.relPath === m.relPath && (
                <IconCheck size={12} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
              )}
            </div>
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
    </div>
  </div>
  );
}

// ─── Changelog Step ──────────────────────────────────────────────────────────

function ChangelogStep({ aiAvailable, onMarkDone }) {
  const [content, setContent]     = useState('');
  const [loading, setLoading]     = useState(true);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving]       = useState(false);
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

  const save = async () => {
    setSaving(true);
    try {
      await api.saveChangelog(content);
      onMarkDone();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
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

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onMarkDone}>
          Skip (Don't Save)
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save & Continue →'}
        </button>
      </div>
    </div>
  );
}

// ─── Release Notes Step ──────────────────────────────────────────────────────

function ReleaseNotesStep({ aiAvailable, onMarkDone }) {
  const [content, setContent]     = useState('');
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving]       = useState(false);
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

  const save = async () => {
    setSaving(true);
    try {
      await api.saveReleaseNotes(content);
      onMarkDone();
    } catch (err) {
      alert(`Save failed: ${err.message}`);
    } finally {
      setSaving(false);
    }
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

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
        <button className="btn btn-ghost" onClick={onMarkDone}>
          Skip (Don't Save)
        </button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Saving...' : 'Save & Continue →'}
        </button>
      </div>
    </div>
  );
}

// ─── Validate Step ───────────────────────────────────────────────────────────

function ValidateStep({ onMarkDone }) {
  const [isValidated, setIsValidated] = useState(false);

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Validate</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 16 }}>
        Run preflight checks to verify the org is ready for deployment.
      </p>
      <CommandRunner
        command="preflight"
        label="Preflight Checks"
        onComplete={() => setIsValidated(true)}
      />

      {isValidated && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn btn-primary" onClick={onMarkDone}>
            Continue to Deploy →
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Deploy Step ─────────────────────────────────────────────────────────────

function DeployStep({ manifest, onMarkDone }) {
  const [orgs, setOrgs]             = useState([]);
  const [targetOrg, setTargetOrg]   = useState('');
  const [testLevel, setTestLevel]   = useState('RunLocalTests');
  const [testClasses, setTestClasses] = useState('');
  const [detectedTests, setDetectedTests] = useState([]);
  const [detecting, setDetecting]     = useState(false);
  const [destructiveTiming, setDestructiveTiming] = useState('post');
  const [deploymentMode, setDeploymentMode] = useState('deploy'); // 'deploy' or 'validate'
  const [tagRelease, setTagRelease]       = useState(true);
  const [createPR, setCreatePR]           = useState(false);
  const [notifySlack, setNotifySlack]     = useState(true);
  const [loadingOrgs, setLoadingOrgs] = useState(true);
  const [isRunning, setIsRunning]   = useState(false);
  const [streamKey, setStreamKey]   = useState(0);

  useEffect(() => {
    api.orgs()
      .then((d) => {
        setOrgs(d.orgs ?? []);
        // Set default org if available
        api.project().then(p => {
          if (p.org) setTargetOrg(p.org);
        }).catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoadingOrgs(false));
  }, []);

  useEffect(() => {
    if (testLevel === 'RunSpecifiedTests' && manifest?.relPath) {
      setDetecting(true);
      api.detectTests(manifest.relPath)
        .then((d) => {
          setDetectedTests(d.tests ?? []);
          if (d.tests?.length > 0 && !testClasses) {
            setTestClasses(d.tests.join(', '));
          }
        })
        .catch(() => {})
        .finally(() => setDetecting(false));
    }
  }, [testLevel, manifest?.relPath]);

  const toggleTest = (name) => {
    const list = testClasses.split(',').map(s => s.trim()).filter(Boolean);
    const newList = list.includes(name) 
      ? list.filter(t => t !== name)
      : [...list, name];
    setTestClasses(newList.join(', '));
  };

  const runDeployment = () => {
    setIsRunning(true);
    setStreamKey(k => k + 1);
  };

  const cliPreview = [
    'sfdt deploy',
    deploymentMode === 'validate' ? '--dry-run' : '',
    `--target-org ${targetOrg}`,
    `--test-level ${testLevel}`,
    testLevel === 'RunSpecifiedTests' && testClasses ? `--tests "${testClasses}"` : '',
    manifest ? `--manifest ${manifest.relPath}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Deploy</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 20 }}>
        Configure your deployment settings and execute.
      </p>

      {!isRunning ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Target Org */}
          <div className="card" style={{ padding: 16 }}>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Target Organization</label>
            {loadingOrgs ? (
              <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Loading orgs...</div>
            ) : (
              <select
                className="input"
                style={{ width: '100%', fontSize: 13 }}
                value={targetOrg}
                onChange={(e) => setTargetOrg(e.target.value)}
              >
                <option value="">Select an org...</option>
                {orgs.map(o => (
                  <option key={o.alias} value={o.alias}>{o.alias} ({o.username})</option>
                ))}
              </select>
            )}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* Mode & Tests */}
            <div className="card" style={{ padding: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Deployment Mode</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <button
                  className={`btn btn-sm ${deploymentMode === 'deploy' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setDeploymentMode('deploy')}
                  style={{ flex: 1 }}
                >
                  Full Deploy
                </button>
                <button
                  className={`btn btn-sm ${deploymentMode === 'validate' ? 'btn-primary' : 'btn-ghost'}`}
                  onClick={() => setDeploymentMode('validate')}
                  style={{ flex: 1 }}
                >
                  Validate Only
                </button>
              </div>

              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Test Level</label>
              <select
                className="input"
                style={{ width: '100%', fontSize: 13, marginBottom: testLevel === 'RunSpecifiedTests' ? 10 : 0 }}
                value={testLevel}
                onChange={(e) => setTestLevel(e.target.value)}
              >
                <option value="NoTestRun">NoTestRun (Metadata Only)</option>
                <option value="RunLocalTests">RunLocalTests (All Local)</option>
                <option value="RunSpecifiedTests">RunSpecifiedTests (Manual List)</option>
                <option value="RunAllTestsInOrg">RunAllTestsInOrg (Managed + Local)</option>
              </select>

              {testLevel === 'RunSpecifiedTests' && (
                <div style={{ marginTop: 10 }}>
                  <input
                    className="input"
                    placeholder="TestClass1, TestClass2..."
                    style={{ width: '100%', fontSize: 12, marginBottom: 8 }}
                    value={testClasses}
                    onChange={(e) => setTestClasses(e.target.value)}
                  />
                  
                  <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--fg-subtle)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                    DETECTED IN MANIFEST {detecting && <div className="live-dot" />}
                  </div>

                  {!detecting && detectedTests.length === 0 && (
                    <div style={{ fontSize: 11, color: 'var(--fg-muted)', fontStyle: 'italic' }}>No test classes found in manifest.</div>
                  )}

                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {detectedTests.map(name => {
                      const isActive = testClasses.split(',').map(s => s.trim()).includes(name);
                      return (
                        <button
                          key={name}
                          onClick={() => toggleTest(name)}
                          style={{
                            padding: '2px 8px',
                            borderRadius: 12,
                            fontSize: 10,
                            cursor: 'pointer',
                            background: isActive ? 'var(--brand-500)' : 'var(--bg-muted)',
                            color: isActive ? 'white' : 'var(--fg-muted)',
                            border: 'none',
                            transition: 'all 0.1s'
                          }}
                        >
                          {name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Destructive & Advanced */}
            <div className="card" style={{ padding: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Destructive Changes</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="destructiveTiming"
                    checked={destructiveTiming === 'post'}
                    onChange={() => setDestructiveTiming('post')}
                  />
                  Post-Destructive (Deploy then Delete)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                  <input
                    type="radio"
                    name="destructiveTiming"
                    checked={destructiveTiming === 'pre'}
                    onChange={() => setDestructiveTiming('pre')}
                  />
                  Pre-Destructive (Delete then Deploy)
                </label>
              </div>

              <div style={{ marginTop: 20, borderTop: '1px solid var(--border-subtle)', paddingTop: 16 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" className="cbx" checked={tagRelease} onChange={e => setTagRelease(e.target.checked)} />
                  Tag Release (Git)
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer', marginBottom: 8 }}>
                  <input type="checkbox" className="cbx" checked={createPR} onChange={e => setCreatePR(e.target.checked)} />
                  Create Pull Request
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                  <input type="checkbox" className="cbx" checked={notifySlack} onChange={e => setNotifySlack(e.target.checked)} />
                  Notify Slack on completion
                </label>
              </div>
            </div>
          </div>

          {/* CLI Preview */}
          <div style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            padding: '10px 14px',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            color: 'var(--fg-muted)',
            position: 'relative'
          }}>
            <div style={{ position: 'absolute', top: -8, left: 12, background: 'var(--bg-surface)', padding: '0 4px', fontSize: 10, fontWeight: 600 }}>CLI PREVIEW</div>
            $ {cliPreview}
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 10 }}>
            <button
              className="btn btn-primary btn-lg"
              disabled={!targetOrg}
              onClick={runDeployment}
              style={{ paddingLeft: 40, paddingRight: 40 }}
            >
              <IconRocket size={16} style={{ marginRight: 8 }} />
              Execute {deploymentMode === 'validate' ? 'Validation' : 'Deployment'}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              Deployment in progress to <span style={{ color: 'var(--brand-600)' }}>{targetOrg}</span>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setIsRunning(false)}>
              <IconRotateCcw size={11} /> Back to Config
            </button>
          </div>

          <StreamRunner
            key={streamKey}
            label={`${deploymentMode === 'validate' ? 'Validating' : 'Deploying'} to ${targetOrg}`}
            startLabel="Deploy"
            streamFn={() => stream.deploy({
              dryRun: deploymentMode === 'validate',
              org: targetOrg,
              manifest: manifest?.relPath,
              testLevel,
              testClasses,
              destructiveTiming,
              tagRelease,
              createPR,
              notifySlack
            })}
            onComplete={onMarkDone}
          />
        </div>
      )}
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
