import { useState, useEffect, useCallback } from 'react';
import { api } from '../api.js';

const SECTIONS = [
  {
    title: 'General',
    fields: [
      { key: 'projectName',     label: 'Project Name',        type: 'text' },
      { key: 'defaultOrg',      label: 'Default Org Alias',   type: 'text' },
      { key: 'releaseNotesDir', label: 'Release Notes Dir',   type: 'text' },
      { key: 'manifestDir',     label: 'Manifest Dir',        type: 'text' },
    ],
  },
  {
    title: 'Deployment',
    fields: [
      { key: 'deployment.coverageThreshold',           label: 'Coverage Threshold (%)', type: 'number' },
      { key: 'deployment.preflight.enforceTests',           label: 'Enforce Tests',              type: 'boolean' },
      { key: 'deployment.preflight.enforceBranchNaming',    label: 'Enforce Branch Naming',      type: 'boolean' },
      { key: 'deployment.preflight.enforceChangelog',       label: 'Enforce Changelog',          type: 'boolean' },
      { key: 'deployment.preflight.enforceGitClean',        label: 'Enforce Git Clean',          type: 'boolean' },
      { key: 'deployment.preflight.enforceSfdxProject',     label: 'Enforce sfdx-project.json',  type: 'boolean' },
      { key: 'deployment.preflight.enforceUntrackedFiles',  label: 'Enforce Untracked Files',    type: 'boolean' },
      { key: 'deployment.preflight.strict',                 label: 'Strict Mode',                type: 'boolean' },
    ],
  },
  {
    title: 'Features',
    fields: [
      { key: 'features.ai',                label: 'AI Features',        type: 'boolean' },
      { key: 'features.notifications',     label: 'Notifications',      type: 'boolean' },
      { key: 'features.releaseManagement', label: 'Release Management', type: 'boolean' },
    ],
  },
  {
    title: 'AI',
    fields: [
      { key: 'ai.provider', label: 'Provider', type: 'select', options: ['claude', 'gemini', 'openai'] },
      { key: 'ai.model',    label: 'Model',    type: 'text' },
    ],
  },
  {
    title: 'Plugins',
    fields: [
      { key: 'pluginOptions.autoDiscover', label: 'Auto-discover Plugins', type: 'boolean' },
    ],
  },
  {
    title: 'DevOps Center MCP',
    fields: [
      { key: 'mcp.enabled',             label: 'Enable MCP Integration',  type: 'boolean' },
      { key: 'mcp.salesforce.command',  label: 'MCP Command',             type: 'text' },
    ],
  },
];

function getNestedValue(obj, key) {
  return key.split('.').reduce((o, k) => o?.[k], obj);
}

function FieldRow({ dotKey, label, type, options, rawConfig, onSave }) {
  const initial = getNestedValue(rawConfig, dotKey);
  const [value, setValue] = useState(initial ?? '');
  const [status, setStatus] = useState(null); // null | 'saving' | 'saved' | 'error'

  useEffect(() => {
    const fresh = getNestedValue(rawConfig, dotKey);
    setValue(fresh ?? '');
  }, [rawConfig, dotKey]);

  async function handleSave() {
    if (dotKey === 'deployment.coverageThreshold') {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        setStatus('error');
        setTimeout(() => setStatus(null), 3000);
        return;
      }
    }
    setStatus('saving');
    try {
      await api.setConfig(dotKey, value);
      setStatus('saved');
      onSave(dotKey, value);
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 3000);
    }
  }

  const inputStyle = {
    padding: '6px 10px',
    borderRadius: '6px',
    border: '1px solid var(--border-input)',
    background: 'var(--bg-input)',
    color: 'var(--fg-default)',
    fontSize: '13px',
    minWidth: 200,
    outline: 'none',
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 0', borderBottom: '1px solid var(--border-subtle)' }}>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-default)', fontWeight: 500 }}>{label}</span>
      {type === 'boolean' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
          <input
            type="checkbox"
            className="cbx"
            checked={!!value}
            onChange={(e) => setValue(e.target.checked)}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)', minWidth: 60 }}>{value ? 'Enabled' : 'Disabled'}</span>
        </label>
      ) : type === 'select' ? (
        <select value={value} onChange={(e) => setValue(e.target.value)} style={inputStyle}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <input
          type={type === 'number' ? 'number' : 'text'}
          value={value}
          onChange={(e) => setValue(type === 'number' ? Number(e.target.value) : e.target.value)}
          style={inputStyle}
          className="input"
          {...(dotKey === 'deployment.coverageThreshold' ? { min: 0, max: 100 } : {})}
        />
      )}
      <button
        className={`btn btn-sm ${status === 'saved' ? 'btn-success' : 'btn-secondary'}`}
        onClick={handleSave}
        disabled={status === 'saving'}
        style={{
          minWidth: 80,
          justifyContent: 'center',
          ...(status === 'saved' ? { background: 'var(--status-identical-bg)', color: 'var(--status-identical-fg)', borderColor: 'var(--status-identical-border)' } : {}),
          ...(status === 'error' ? { background: 'var(--status-conflict-bg)', color: 'var(--status-conflict-fg)', borderColor: 'var(--status-conflict-border)' } : {}),
        }}
      >
        {status === 'saving' ? '…' : status === 'saved' ? '✓ Saved' : status === 'error' ? '✗ Error' : 'Save'}
      </button>
    </div>
  );
}

function InitCard() {
  const [projectName, setProjectName] = useState('');
  const [defaultOrg, setDefaultOrg] = useState('');
  const [busy, setBusy] = useState(false);
  const [initError, setInitError] = useState(null);

  async function handleInit(e) {
    e.preventDefault();
    if (!projectName.trim()) return;
    setBusy(true);
    setInitError(null);
    try {
      await api.initProject({ projectName: projectName.trim(), defaultOrg: defaultOrg.trim() });
      window.location.reload();
    } catch (err) {
      setInitError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-text">
          <h1>Initialize Project</h1>
          <p className="page-subtitle">No .sfdt/ configuration found. Fill in the basics to get started.</p>
        </div>
      </div>
      <div className="card card-pad" style={{ maxWidth: 480 }}>
        <form onSubmit={handleInit} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label className="field-label" htmlFor="init-project-name">Project Name <span style={{ color: 'var(--c-danger)' }}>*</span></label>
            <input
              id="init-project-name"
              className="field-input"
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="My Salesforce Project"
              required
            />
          </div>
          <div>
            <label className="field-label" htmlFor="init-default-org">Default Org Alias</label>
            <input
              id="init-default-org"
              className="field-input"
              type="text"
              value={defaultOrg}
              onChange={(e) => setDefaultOrg(e.target.value)}
              placeholder="my-sandbox"
            />
          </div>
          {initError && <div className="alert alert-error" style={{ fontSize: 13 }}>{initError}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !projectName.trim()}>
              {busy ? <span className="spinner" style={{ width: 14, height: 14 }} /> : 'Initialize Project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── AI Prompts tab ──────────────────────────────────────────────────────────

function PromptEditor() {
  const [prompts, setPrompts]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [selected, setSelected]     = useState(null);
  const [editValue, setEditValue]   = useState('');
  const [status, setStatus]         = useState(null); // null|'saving'|'saved'|'error'|'resetting'

  const load = useCallback(() => {
    setLoading(true);
    api.listPrompts()
      .then(({ prompts: list }) => {
        setPrompts(list ?? []);
        setSelected((prev) => {
          const key = prev ?? list?.[0]?.key;
          const found = (list ?? []).find((p) => p.key === key) ?? list?.[0];
          if (found) setEditValue(found.current);
          return found?.key ?? null;
        });
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const selectedPrompt = prompts.find((p) => p.key === selected);

  function selectPrompt(p) {
    setSelected(p.key);
    setEditValue(p.current);
    setStatus(null);
  }

  async function handleSave() {
    if (!selected) return;
    setStatus('saving');
    try {
      await api.setPrompt(selected, editValue);
      setStatus('saved');
      setPrompts((prev) => prev.map((p) => p.key === selected ? { ...p, current: editValue, overridden: editValue !== p.default } : p));
      setTimeout(() => setStatus(null), 2000);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 3000);
    }
  }

  async function handleReset() {
    if (!selected) return;
    setStatus('resetting');
    try {
      await api.resetPrompt(selected);
      setPrompts((prev) => prev.map((p) => {
        if (p.key !== selected) return p;
        setEditValue(p.default);
        return { ...p, current: p.default, overridden: false };
      }));
      setStatus(null);
    } catch {
      setStatus('error');
      setTimeout(() => setStatus(null), 3000);
    }
  }

  if (loading) return <div className="spinner-center"><div className="spinner" /></div>;

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 20, minHeight: 480 }}>
      {/* Sidebar */}
      <div style={{ borderRight: '1px solid var(--border-subtle)', paddingRight: 16 }}>
        {prompts.map((p) => (
          <button
            key={p.key}
            onClick={() => selectPrompt(p)}
            style={{
              display: 'block', width: '100%', textAlign: 'left',
              padding: '8px 10px', borderRadius: 'var(--r-sm)', border: 'none', cursor: 'pointer',
              background: p.key === selected ? 'var(--bg-subtle)' : 'transparent',
              color: p.key === selected ? 'var(--fg-default)' : 'var(--fg-muted)',
              fontSize: 'var(--fs-sm)', marginBottom: 2,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              {p.overridden && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--c-warning)', flexShrink: 0 }} />
              )}
              {!p.overridden && (
                <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'transparent', flexShrink: 0 }} />
              )}
              {p.label}
            </div>
          </button>
        ))}
        <div style={{ marginTop: 16, fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', paddingLeft: 2 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--c-warning)', display: 'inline-block' }} />
            Modified
          </span>
        </div>
      </div>

      {/* Editor */}
      {selectedPrompt ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 'var(--fs-sm)', color: 'var(--fg-default)', marginBottom: 4 }}>
              {selectedPrompt.label}
              {selectedPrompt.overridden && (
                <span className="badge badge-warning" style={{ marginLeft: 8, fontSize: 10 }}>Modified</span>
              )}
            </div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', marginBottom: 2 }}>{selectedPrompt.description}</div>
            <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>Used by: {selectedPrompt.feature}</div>
          </div>

          <textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            style={{
              flex: 1, minHeight: 340, fontFamily: 'var(--font-mono)', fontSize: 12,
              background: 'var(--bg-subtle)', color: 'var(--fg-default)',
              border: '1px solid var(--border-input)', borderRadius: 'var(--r-md)',
              padding: '10px 12px', resize: 'vertical', outline: 'none',
              lineHeight: 1.55,
            }}
            spellCheck={false}
          />

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              className={`btn btn-sm ${status === 'saved' ? 'btn-success' : 'btn-primary'}`}
              onClick={handleSave}
              disabled={status === 'saving' || status === 'resetting'}
              style={{
                ...(status === 'saved' ? { background: 'var(--status-identical-bg)', color: 'var(--status-identical-fg)', borderColor: 'var(--status-identical-border)' } : {}),
                ...(status === 'error' ? { background: 'var(--status-conflict-bg)', color: 'var(--status-conflict-fg)', borderColor: 'var(--status-conflict-border)' } : {}),
              }}
            >
              {status === 'saving' ? 'Saving…' : status === 'saved' ? '✓ Saved' : status === 'error' ? '✗ Error' : 'Save'}
            </button>

            {selectedPrompt.overridden && (
              <button
                className="btn btn-ghost btn-sm"
                onClick={handleReset}
                disabled={status === 'saving' || status === 'resetting'}
              >
                {status === 'resetting' ? 'Resetting…' : 'Reset to default'}
              </button>
            )}

            <span style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)', marginLeft: 'auto' }}>
              {editValue.length.toLocaleString()} chars
            </span>
          </div>

          {selectedPrompt.overridden && (
            <details style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-subtle)' }}>
              <summary style={{ cursor: 'pointer', userSelect: 'none' }}>View default prompt</summary>
              <pre style={{
                marginTop: 8, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap',
                wordBreak: 'break-word', background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--r-sm)', padding: '8px 10px', color: 'var(--fg-muted)', maxHeight: 200, overflow: 'auto',
              }}>
                {selectedPrompt.default}
              </pre>
            </details>
          )}
        </div>
      ) : (
        <div style={{ padding: 40, color: 'var(--fg-subtle)', textAlign: 'center' }}>Select a prompt</div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const [tab, setTab] = useState('config');
  const [rawConfig, setRawConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notInitialized, setNotInitialized] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getConfig()
      .then(setRawConfig)
      .catch((e) => {
        if (e.status === 503) setNotInitialized(true);
        else setError(e.message);
      })
      .finally(() => setLoading(false));
  }, []);

  function handleSave(key, value) {
    setRawConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev };
      const parts = key.split('.');
      const last = parts.pop();
      const target = parts.reduce((o, k) => {
        o[k] = { ...(o[k] ?? {}) };
        return o[k];
      }, next);
      target[last] = value;
      return next;
    });
  }

  if (loading) return <div className="spinner-center"><div className="spinner" /></div>;
  if (notInitialized) return <InitCard />;
  if (error) return <div style={{ padding: 32 }}><div className="alert alert-error">{error}</div></div>;
  if (!rawConfig) return null;

  const TABS = [
    { key: 'config', label: 'Config' },
    { key: 'prompts', label: 'AI Prompts' },
  ];

  return (
    <div className="page-content">
      <div className="page-header">
        <div className="page-header-text">
          <h1>Settings</h1>
          <p className="page-subtitle">Project configuration and AI prompt customization</p>
        </div>
      </div>

      {/* Tab bar */}
      <div style={{ display: 'flex', gap: 2, borderBottom: '1px solid var(--border-subtle)', marginBottom: 24 }}>
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: '8px 16px', border: 'none', background: 'none', cursor: 'pointer',
              fontSize: 'var(--fs-sm)', fontWeight: tab === t.key ? 600 : 400,
              color: tab === t.key ? 'var(--fg-brand)' : 'var(--fg-muted)',
              borderBottom: tab === t.key ? '2px solid var(--fg-brand)' : '2px solid transparent',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'config' && (
        <>
          <div className="alert alert-info mb-6">
            <div style={{ fontSize: 12 }}>
              Changes are written to <code>.sfdt/config.json</code> immediately. Restart <code>sfdt ui</code> to apply feature or AI provider changes.
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
            {SECTIONS.map((section) => (
              <div key={section.title} className="card card-pad">
                <div className="section-label" style={{ marginBottom: 16 }}>{section.title}</div>
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {section.fields.map((field) => (
                    <FieldRow
                      key={field.key}
                      dotKey={field.key}
                      label={field.label}
                      type={field.type}
                      options={field.options}
                      rawConfig={rawConfig}
                      onSave={handleSave}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {tab === 'prompts' && (
        <div className="card card-pad">
          <div className="section-label" style={{ marginBottom: 4 }}>AI Prompts</div>
          <div style={{ fontSize: 'var(--fs-xs)', color: 'var(--fg-muted)', marginBottom: 20 }}>
            Customize the system prompts used by each AI feature. Overrides are saved to <code>.sfdt/prompts.json</code>.
            Use <strong>Reset to default</strong> to restore the built-in prompt.
          </div>
          <PromptEditor />
        </div>
      )}
    </div>
  );
}
