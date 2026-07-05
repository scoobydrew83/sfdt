import { useState } from 'react';
import HealthChecks from '../components/HealthChecks.jsx';
import { api, stream } from '../api.js';
import { SnapshotRunCard } from './Docs.jsx';

export default function MonitorPage() {
  // Bump the key to remount HealthChecks after a run so it re-fetches the
  // fresh snapshot written by the CLI.
  const [runSeq, setRunSeq] = useState(0);

  return (
    <div>
      <SnapshotRunCard
        title="Run Monitor"
        commandLabel="sfdt monitor all"
        startStream={() => stream.monitorRun()}
        onComplete={() => setRunSeq((n) => n + 1)}
      />
      <HealthChecks
        key={runSeq}
        title="Org Monitor"
        subtitle="Org limits, recent Apex job failures, security health-check, and metadata backup"
        pageKey="monitor"
        command="monitor all"
        fetcher={api.monitor}
      />
    </div>
  );
}
