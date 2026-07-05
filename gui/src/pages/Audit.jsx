import { useState } from 'react';
import HealthChecks from '../components/HealthChecks.jsx';
import { api, stream } from '../api.js';
import { SnapshotRunCard } from './Docs.jsx';

export default function AuditPage() {
  // Bump the key to remount HealthChecks after a run so it re-fetches the
  // fresh snapshot written by the CLI.
  const [runSeq, setRunSeq] = useState(0);

  return (
    <div>
      <SnapshotRunCard
        title="Run Audit"
        commandLabel="sfdt audit all"
        startStream={() => stream.auditRun()}
        onComplete={() => setRunSeq((n) => n + 1)}
      />
      <HealthChecks
        key={runSeq}
        title="Org Audit"
        subtitle="Diagnose org health — audit trail, licenses, MFA, unused Apex, inactive users, API versions"
        pageKey="audit"
        command="audit all"
        fetcher={api.audit}
      />
    </div>
  );
}
