import HealthChecks from '../components/HealthChecks.jsx';
import { api } from '../api.js';

export default function MonitorPage() {
  return (
    <HealthChecks
      title="Org Monitor"
      subtitle="Org limits, recent Apex job failures, security health-check, and metadata backup"
      pageKey="monitor"
      command="monitor all"
      fetcher={api.monitor}
    />
  );
}
