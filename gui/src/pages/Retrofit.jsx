import { useState, useEffect } from 'react';
import { api } from '../api.js';
import CommandRunner from '../components/CommandRunner.jsx';

const METADATA_RE = /^[A-Za-z0-9_]+(?:,[A-Za-z0-9_]+)*$/;

export default function RetrofitPage() {
  const [orgs, setOrgs]         = useState([]);
  const [source, setSource]     = useState('');
  const [target, setTarget]     = useState('');
  const [metadata, setMetadata] = useState('');
  const [execute, setExecute]   = useState(false);

  useEffect(() => {
    api.orgs().then(({ orgs: list }) => setOrgs(list ?? [])).catch(() => {});
  }, []);

  const metadataValid = metadata === '' || METADATA_RE.test(metadata);
  const ready = source && target && source !== target && metadataValid;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Retrofit</h1>
          <p className="page-subtitle">Retrieve a metadata set from a source org and smart-deploy it to a target</p>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-head"><div className="card-title">Configure Retrofit</div></div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <div className="input-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="input-label">Source org (retrieve from)</label>
              <select className="input" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Select org…</option>
                {orgs.map((o) => <option key={o.alias} value={o.alias}>{o.alias}</option>)}
              </select>
            </div>
            <div className="input-field" style={{ flex: 1, minWidth: 180 }}>
              <label className="input-label">Target org (deploy to)</label>
              <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
                <option value="">Select org…</option>
                {orgs.map((o) => <option key={o.alias} value={o.alias}>{o.alias}</option>)}
              </select>
            </div>
          </div>

          <div className="input-field" style={{ marginTop: 'var(--s-4)' }}>
            <label className="input-label">Metadata types (optional, comma-separated)</label>
            <input
              className="input"
              placeholder="e.g. CustomObject,Flow,PermissionSet (blank = configured default set)"
              value={metadata}
              onChange={(e) => setMetadata(e.target.value.replace(/\s+/g, ''))}
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--s-2)', marginTop: 'var(--s-4)', cursor: 'pointer' }}>
            <input type="checkbox" checked={execute} onChange={(e) => setExecute(e.target.checked)} />
            <span style={{ color: execute ? 'var(--status-conflict-fg)' : 'var(--fg-default)' }}>
              Execute the deploy to the target (unchecked = validate-only, no changes)
            </span>
          </label>

          {source && target && source === target && (
            <p style={{ color: 'var(--status-conflict-fg)', fontSize: 'var(--fs-sm)', marginTop: 'var(--s-2)' }}>
              Source and target must be different orgs.
            </p>
          )}
          {!metadataValid && (
            <p style={{ color: 'var(--status-conflict-fg)', fontSize: 'var(--fs-sm)', marginTop: 'var(--s-2)' }}>
              Metadata must be comma-separated type names (letters, digits, underscores).
            </p>
          )}
        </div>
      </div>

      {ready ? (
        <CommandRunner
          key={`${source}:${target}:${metadata}:${execute}`}
          command="retrofit"
          label={`sfdt retrofit --source ${source} --target ${target}${execute ? ' --execute' : ' (validate-only)'}`}
          extraParams={{ source, target, metadata: metadata || undefined, execute }}
        />
      ) : (
        <div className="card">
          <div className="card-body" style={{ color: 'var(--fg-muted)' }}>
            Choose distinct source and target orgs to retrofit.
          </div>
        </div>
      )}
    </div>
  );
}
