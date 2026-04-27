import { useState, useEffect } from 'react';
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
      { key: 'deployment.preflight.enforceTests',      label: 'Enforce Tests',          type: 'boolean' },
      { key: 'deployment.preflight.enforceBranchNaming', label: 'Enforce Branch Naming', type: 'boolean' },
      { key: 'deployment.preflight.enforceChangelog',  label: 'Enforce Changelog',      type: 'boolean' },
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
    padding: '4px 8px',
    borderRadius: '6px',
    border: '1px solid var(--border)',
    background: 'var(--bg-card)',
    color: 'var(--fg)',
    fontSize: '13px',
    minWidth: 180,
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--border-faint, var(--border))' }}>
      <span style={{ flex: 1, fontSize: 13, color: 'var(--fg-muted)' }}>{label}</span>
      {type === 'boolean' ? (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => setValue(e.target.checked)}
            style={{ width: 15, height: 15, cursor: 'pointer' }}
          />
          <span style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{value ? 'Enabled' : 'Disabled'}</span>
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
        />
      )}
      <button
        onClick={handleSave}
        disabled={status === 'saving'}
        style={{
          padding: '4px 12px',
          borderRadius: '6px',
          border: '1px solid var(--border)',
          background: status === 'saved' ? 'var(--success-bg, #dcfce7)' : status === 'error' ? 'var(--error-bg, #fee2e2)' : 'var(--bg-card)',
          color: status === 'saved' ? '#16a34a' : status === 'error' ? '#dc2626' : 'var(--fg)',
          fontSize: 12,
          cursor: status === 'saving' ? 'default' : 'pointer',
        }}
      >
        {status === 'saving' ? '…' : status === 'saved' ? '✓ Saved' : status === 'error' ? '✗ Error' : 'Save'}
      </button>
    </div>
  );
}

export default function SettingsPage() {
  const [rawConfig, setRawConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.getConfig()
      .then(setRawConfig)
      .catch((e) => setError(e.message))
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

  if (loading) return <div style={{ padding: 32, color: 'var(--fg-muted)' }}>Loading config…</div>;
  if (error) return <div style={{ padding: 32, color: '#dc2626' }}>Failed to load config: {error}</div>;
  if (!rawConfig) return null;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Settings</h1>
          <p className="page-subtitle">View and edit your .sfdt/config.json project settings</p>
        </div>
      </div>

      <p style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 20 }}>
        Changes are written to <code>.sfdt/config.json</code> immediately. Restart <code>sfdt ui</code> to apply feature or AI provider changes.
      </p>

      {SECTIONS.map((section) => (
        <div key={section.title} className="card" style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12, color: 'var(--fg)' }}>{section.title}</div>
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
      ))}
    </div>
  );
}
