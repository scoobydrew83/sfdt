import { useState, useRef, useEffect } from 'react';
import Button from '@salesforce/design-system-react/components/button';
import Spinner from '@salesforce/design-system-react/components/spinner';
import Badge from '@salesforce/design-system-react/components/badge';

export default function CommandRunner({ command, label, onComplete = () => {} }) {
  const [status, setStatus] = useState('idle');
  const [lines, setLines] = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const esRef = useRef(null);
  const logRef = useRef(null);
  const lineCounterRef = useRef(0);
  const unmountedRef = useRef(false);

  // Scroll log pane to bottom whenever lines change
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines]);

  // Cleanup EventSource on unmount
  useEffect(() => {
    return () => {
      unmountedRef.current = true;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, []);

  const reset = () => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    lineCounterRef.current = 0;
    setStatus('idle');
    setLines([]);
    setExitCode(null);
  };

  const startCommand = () => {
    setStatus('running');
    setLines([]);
    setExitCode(null);
    lineCounterRef.current = 0;

    const es = new EventSource(`/api/command/run?command=${encodeURIComponent(command)}`);
    esRef.current = es;

    es.onmessage = (e) => {
      if (unmountedRef.current) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'log') {
        const id = lineCounterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      }
      if (msg.type === 'result') {
        const succeeded = msg.exitCode === 0;
        setStatus(succeeded ? 'done' : 'error');
        setExitCode(msg.exitCode);
        es.close();
        esRef.current = null;
        if (succeeded) onComplete();
      }
      if (msg.type === 'error') {
        setStatus('error');
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      if (unmountedRef.current) return;
      setStatus('error');
      es.close();
      esRef.current = null;
    };
  };

  const logPane = (
    <div
      ref={logRef}
      style={{
        fontFamily: 'monospace',
        fontSize: '12px',
        maxHeight: '200px',
        overflowY: 'auto',
        background: '#032d60',
        color: '#fff',
        padding: '12px',
        borderRadius: '4px',
        marginTop: '8px',
      }}
    >
      {lines.map(({ id, text }) => (
        <div key={id}>{text}</div>
      ))}
    </div>
  );

  return (
    <div className="slds-m-bottom_medium">
      {status === 'idle' && (
        <Button variant="brand" label={`Run ${label}`} onClick={startCommand} />
      )}

      {status === 'running' && (
        <div>
          <div className="slds-grid slds-grid_vertical-align-center slds-gutters_small">
            <div className="slds-col slds-grow-none" style={{ position: 'relative', width: '32px', height: '32px' }}>
              <Spinner size="small" variant="brand" />
            </div>
            <div className="slds-col slds-grow-none">
              <span className="slds-text-body_regular">{label} running…</span>
            </div>
            <div className="slds-col slds-grow-none">
              <Button variant="neutral" label="Cancel" onClick={reset} />
            </div>
          </div>
          {logPane}
        </div>
      )}

      {status === 'done' && (
        <div className="slds-grid slds-grid_vertical-align-center slds-gutters_small">
          <div className="slds-col slds-grow-none">
            <Badge content="Run complete" color="success" />
          </div>
          <div className="slds-col slds-grow-none">
            <Button variant="neutral" label="Run Again" onClick={reset} />
          </div>
        </div>
      )}

      {status === 'error' && (
        <div>
          <div className="slds-grid slds-grid_vertical-align-center slds-gutters_small">
            <div className="slds-col slds-grow-none">
              <Badge content={exitCode != null ? `Run failed (exit ${exitCode})` : 'Run failed'} color="error" />
            </div>
            <div className="slds-col slds-grow-none">
              <Button variant="neutral" label="Run Again" onClick={reset} />
            </div>
          </div>
          {logPane}
        </div>
      )}
    </div>
  );
}
