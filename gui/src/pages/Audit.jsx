import HealthChecks from '../components/HealthChecks.jsx';
import { api } from '../api.js';

export default function AuditPage() {
  return (
    <HealthChecks
      title="Org Audit"
      subtitle="Diagnose org health — audit trail, licenses, MFA, unused Apex, inactive users, API versions"
      pageKey="audit"
      command="audit all"
      fetcher={api.audit}
    />
  );
}
