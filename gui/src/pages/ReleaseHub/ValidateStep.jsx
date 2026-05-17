import { useState } from 'react';
import CommandRunner from '../../components/CommandRunner.jsx';

// ─── Validate Step ───────────────────────────────────────────────────────────

export default function ValidateStep({ onMarkDone }) {
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
        onComplete={(code) => { if (code === 0) setIsValidated(true); }}
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
