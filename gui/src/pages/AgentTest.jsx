import { useState, useEffect } from 'react';
import { api } from '../api.js';
import CommandRunner from '../components/CommandRunner.jsx';

const SPEC_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

export default function AgentTestPage() {
  const [orgs, setOrgs] = useState([]);
  const [org, setOrg]   = useState('');
  const [spec, setSpec] = useState('');

  useEffect(() => {
    api.orgs()
      .then(({ orgs: list }) => {
        setOrgs(list ?? []);
        if (list?.length) setOrg(list[0].alias);
      })
      .catch(() => {});
  }, []);

  const specValid = SPEC_RE.test(spec);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-text">
          <h1>Agent Test</h1>
          <p className="page-subtitle">Run an Agentforce agent test (AiEvaluationDefinition) as a gate</p>
        </div>
      </div>

      <div className="card mb-4">
        <div className="card-head"><div className="card-title">Run Agent Test</div></div>
        <div className="card-body">
          <div style={{ display: 'flex', gap: 'var(--s-4)', flexWrap: 'wrap' }}>
            <div className="input-field" style={{ flex: 1, minWidth: 220 }}>
              <label className="input-label">Agent test spec (API name)</label>
              <input
                className="input"
                placeholder="e.g. Support_Eval"
                value={spec}
                onChange={(e) => setSpec(e.target.value.trim())}
              />
            </div>
            <div className="input-field" style={{ minWidth: 180 }}>
              <label className="input-label">Org</label>
              <select className="input" value={org} onChange={(e) => setOrg(e.target.value)}>
                <option value="">Default org</option>
                {orgs.map((o) => <option key={o.alias} value={o.alias}>{o.alias}</option>)}
              </select>
            </div>
          </div>
          {spec.length > 0 && !specValid && (
            <p style={{ color: 'var(--status-conflict-fg)', fontSize: 'var(--fs-sm)', marginTop: 'var(--s-2)' }}>
              Spec must be a valid API name — letters, digits, and underscores, starting with a letter.
            </p>
          )}
        </div>
      </div>

      {specValid ? (
        <CommandRunner
          key={`${spec}:${org}`}
          command="agent-test"
          label={`sfdt agent-test --spec ${spec}${org ? ` --org ${org}` : ''}`}
          extraParams={{ spec, targetOrg: org || undefined }}
        />
      ) : (
        <div className="card">
          <div className="card-body" style={{ color: 'var(--fg-muted)' }}>
            Enter an agent test spec (the AiEvaluationDefinition API name) to run.
          </div>
        </div>
      )}
    </div>
  );
}
