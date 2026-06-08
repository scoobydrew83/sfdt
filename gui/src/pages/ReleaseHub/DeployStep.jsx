import { useState, useEffect } from 'react';
import { api, stream } from '../../api.js';
import StreamRunner from '../../components/StreamRunner.jsx';
import { IconRocket, IconRotateCcw } from '../../Icons.jsx';

// ─── Deploy Step ─────────────────────────────────────────────────────────────

export default function DeployStep({ manifest, sourceDir, onMarkDone }) {
  const [orgs, setOrgs]             = useState([]);
  const [targetOrg, setTargetOrg]   = useState('');
  const [testLevel, setTestLevel]   = useState('RunLocalTests');
  const [testClasses, setTestClasses] = useState('');
  const [detectedTests, setDetectedTests] = useState([]);
  const [detecting, setDetecting]     = useState(false);
  const [destructiveTiming, setDestructiveTiming] = useState('post');
  const [deploymentMode, setDeploymentMode] = useState('deploy'); // 'deploy' or 'validate'
  const [tagRelease, setTagRelease]       = useState(false);
  const [createPR, setCreatePR]           = useState(false);
  const [notifySlack, setNotifySlack]     = useState(false);
  const [loadingOrgs, setLoadingOrgs] = useState(true);
  const [isRunning, setIsRunning]   = useState(false);
  const [streamKey, setStreamKey]   = useState(0);
  const [orgError, setOrgError]     = useState(false);
  const [lastDeployStats, setLastDeployStats] = useState(null);
  // Captured from a successful validate run so the next Quick Deploy can
  // reuse the validation job and skip the test re-run.
  const [validationJobId, setValidationJobId] = useState(null);

  const updateValidationJobId = (jobId) => {
    setValidationJobId(jobId);
    if (manifest?.relPath) {
      const key = `sfdt_validation_${manifest.relPath}`;
      try {
        if (jobId) {
          const value = {
            validationJobId: jobId,
            targetOrg,
            timestamp: Date.now()
          };
          localStorage.setItem(key, JSON.stringify(value));
        } else {
          localStorage.removeItem(key);
        }
      } catch (e) {
        console.error('Failed to persist validation to localStorage', e);
      }
    }
  };

  useEffect(() => {
    if (manifest?.relPath) {
      const key = `sfdt_validation_${manifest.relPath}`;
      try {
        const stored = localStorage.getItem(key);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (parsed && Date.now() - parsed.timestamp < 24 * 60 * 60 * 1000) {
            setValidationJobId(parsed.validationJobId);
            if (parsed.targetOrg) setTargetOrg(parsed.targetOrg);
          } else {
            localStorage.removeItem(key);
          }
        } else {
          setValidationJobId(null);
        }
      } catch (e) {
        console.error('Failed to load validation from localStorage', e);
      }
    }
  }, [manifest?.relPath]);

  useEffect(() => {
    let cancelled = false;
    api.orgs()
      .then((d) => {
        if (cancelled) return;
        setOrgs(d.orgs ?? []);
        // Set default org if available
        api.project().then(p => {
          if (!cancelled && p.org) setTargetOrg(p.org);
        }).catch(() => {});
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoadingOrgs(false); });
    // Load last deploy stats for metrics panel
    api.deployHistory()
      .then((d) => {
        if (cancelled) return;
        const last = d.history?.[0];
        if (last) setLastDeployStats(last);
      })
      .catch(() => {});
    return () => { cancelled = true; };
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
  }, [testLevel, manifest?.relPath, testClasses]);

  const toggleTest = (name) => {
    const list = testClasses.split(',').map(s => s.trim()).filter(Boolean);
    const newList = list.includes(name)
      ? list.filter(t => t !== name)
      : [...list, name];
    setTestClasses(newList.join(', '));
  };

  const runDeployment = () => {
    if (!targetOrg) { setOrgError(true); return; }
    setOrgError(false);
    setIsRunning(true);
    setStreamKey(k => k + 1);
  };

  const cliPreview = [
    'sfdt deploy',
    deploymentMode === 'validate' ? '--dry-run' : '',
    `--target-org ${targetOrg}`,
    `--test-level ${testLevel}`,
    testLevel === 'RunSpecifiedTests' && testClasses
      ? testClasses.split(',').map(s => s.trim()).filter(Boolean).map(t => `--tests ${t}`).join(' ')
      : '',
    manifest ? `--manifest ${manifest.relPath}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div style={{ padding: 20 }}>
      <h2 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Deploy</h2>
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: 20 }}>
        Configure your deployment settings and execute.
      </p>

      {!isRunning ? (
        <div className="deploy-grid">
          {/* ── Left: main controls ── */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Target Org */}
            <div className="card" style={{ padding: 16 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Target Organization</label>
              {loadingOrgs ? (
                <div style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Loading orgs...</div>
              ) : (
                <select
                  className="input"
                  style={{ width: '100%', fontSize: 13, borderColor: orgError ? 'var(--status-conflict-fg)' : undefined }}
                  value={targetOrg}
                  onChange={(e) => {
                    const newOrg = e.target.value;
                    setTargetOrg(newOrg);
                    if (newOrg) setOrgError(false);
                    updateValidationJobId(null);
                  }}
                >
                  <option value="">Select an org...</option>
                  {orgs.map(o => (
                    <option key={o.alias} value={o.alias}>{o.alias}{o.username ? ` (${o.username})` : ''}</option>
                  ))}
                </select>
              )}
              {orgError && (
                <div style={{ marginTop: 6, fontSize: 12, color: 'var(--status-conflict-fg)' }}>
                  A target org is required to execute the deployment.
                </div>
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
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="destructiveTiming"
                      checked={destructiveTiming === 'none'}
                      onChange={() => setDestructiveTiming('none')}
                    />
                    Skip Destructive (metadata only)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="destructiveTiming"
                      checked={destructiveTiming === 'only'}
                      onChange={() => setDestructiveTiming('only')}
                    />
                    Destructive Only (no metadata deploy)
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

            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
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

          {/* ── Right: metrics sidebar ── */}
          <div className="metrics-panel" style={{ alignSelf: 'start' }}>
            <div className="panel-hdr">Last Deploy Metrics</div>
            {!lastDeployStats ? (
              <div className="metric-row" style={{ color: 'var(--fg-subtle)', fontStyle: 'italic' }}>
                No deploy history
              </div>
            ) : (
              <>
                <div className="metric-row">
                  <span className="metric-key">Org</span>
                  <span className="metric-val">{lastDeployStats.org ?? '—'}</span>
                </div>
                <div className="metric-row">
                  <span className="metric-key">Status</span>
                  <span className={`metric-val ${lastDeployStats.exitCode === 0 ? 'ok' : 'warn'}`}>
                    {lastDeployStats.exitCode === 0 ? 'Success' : 'Failed'}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="metric-key">Manifest</span>
                  <span className="metric-val" style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {lastDeployStats.manifest ?? '—'}
                  </span>
                </div>
                <div className="metric-row">
                  <span className="metric-key">Date</span>
                  <span className="metric-val">
                    {lastDeployStats.date ? new Date(lastDeployStats.date).toLocaleDateString() : '—'}
                  </span>
                </div>
                {lastDeployStats.coverage != null && (
                  <div className="metric-row">
                    <span className="metric-key">Coverage</span>
                    <span className={`metric-val ${lastDeployStats.coverage >= 75 ? 'ok' : 'warn'}`}>
                      {lastDeployStats.coverage}%
                    </span>
                  </div>
                )}
                {lastDeployStats.testsPassed != null && (
                  <div className="metric-row">
                    <span className="metric-key">Tests Passed</span>
                    <span className="metric-val ok">{lastDeployStats.testsPassed}</span>
                  </div>
                )}
                {lastDeployStats.componentCount != null && (
                  <div className="metric-row">
                    <span className="metric-key">Components</span>
                    <span className="metric-val">{lastDeployStats.componentCount}</span>
                  </div>
                )}
                {lastDeployStats.dryRun && (
                  <div className="metric-row">
                    <span className="metric-key">Mode</span>
                    <span className="metric-val warn">Validate Only</span>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>
              {sourceDir
                ? <>Deploying folder <span style={{ color: 'var(--brand-600)' }}>{sourceDir}</span> to <span style={{ color: 'var(--brand-600)' }}>{targetOrg}</span></>
                : <>Deployment in progress to <span style={{ color: 'var(--brand-600)' }}>{targetOrg}</span></>
              }
            </div>
            <button className="btn btn-ghost btn-sm" onClick={() => setIsRunning(false)}>
              <IconRotateCcw size={11} /> Back to Config
            </button>
          </div>

          <StreamRunner
            key={streamKey}
            autoStart={isRunning}
            label={`${deploymentMode === 'validate' ? 'Validating' : 'Deploying'} to ${targetOrg}`}
            startLabel="Deploy"
            commandHint={`sfdt deploy${deploymentMode === 'validate' ? ' --dry-run' : validationJobId ? ` --quick (job ${validationJobId})` : ''}`}
            streamFn={() => stream.deploy({
              dryRun: deploymentMode === 'validate',
              org: targetOrg,
              manifest: manifest?.relPath,
              sourceDir,
              testLevel,
              testClasses,
              destructiveTiming,
              tagRelease,
              createPR,
              notifySlack,
              // Only pass the validation job id on a non-validate run — sending
              // it on the validate path would have no effect server-side.
              ...(deploymentMode === 'deploy' && validationJobId
                ? { validationJobId }
                : {}),
            })}
            onComplete={(content) => {
              // Validate-mode success captures the job id so a follow-up
              // Quick Deploy can reuse it. We deliberately do NOT auto-advance
              // to Rollback — that's the navigation that produced the "black
              // screen" symptom on production validates.
              if (deploymentMode === 'validate') {
                if (content?.validationJobId) updateValidationJobId(content.validationJobId);
                return;
              }
              // Real deploy completed — clear any stale job id so the next
              // validate-then-deploy cycle starts fresh.
              updateValidationJobId(null);
              onMarkDone();
            }}
          />

          {deploymentMode === 'validate' && (
            <div
              style={{
                marginTop: 12,
                padding: '10px 12px',
                background: 'var(--status-identical-bg)',
                border: '1px solid var(--status-identical-border)',
                borderRadius: 'var(--r-md)',
                color: 'var(--status-identical-fg)',
                fontSize: 12,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <span>
                Validation completed against <strong>{targetOrg}</strong>.
                {validationJobId ? (
                  <>
                    {' '}Quick Deploy will reuse validation job{' '}
                    <code style={{ fontFamily: 'var(--font-mono)' }}>{validationJobId}</code>
                    {' '}— Salesforce skips the test re-run.
                  </>
                ) : (
                  <>
                    {' '}Job ID wasn’t captured; Quick Deploy will re-run the deploy
                    end-to-end (tests will run again).
                  </>
                )}
              </span>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setDeploymentMode('deploy');
                  setStreamKey((k) => k + 1);
                }}
              >
                <IconRocket size={11} /> Quick Deploy
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
