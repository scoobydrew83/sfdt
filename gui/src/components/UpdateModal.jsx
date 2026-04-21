import { useState, useRef, useEffect } from 'react';
import { IconX, IconDownload, IconAlertTri } from '../Icons.jsx';

export default function UpdateModal({ current, latest, onClose }) {
  const [status, setStatus]   = useState('idle'); // idle | running | done | error
  const [lines, setLines]     = useState([]);
  const [exitCode, setExitCode] = useState(null);
  const esRef     = useRef(null);
  const logRef    = useRef(null);
  const counterRef = useRef(0);
  const deadRef   = useRef(false);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  useEffect(() => {
    return () => {
      deadRef.current = true;
      esRef.current?.close();
    };
  }, []);

  const startUpdate = () => {
    setStatus('running');
    setLines([]);
    setExitCode(null);
    counterRef.current = 0;

    const es = new EventSource('/api/update/stream');
    esRef.current = es;

    es.onmessage = (e) => {
      if (deadRef.current) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === 'log') {
        const id = counterRef.current++;
        setLines((prev) => [...prev, { id, text: msg.line }]);
      } else if (msg.type === 'result') {
        setStatus(msg.exitCode === 0 ? 'done' : 'error');
        setExitCode(msg.exitCode);
        es.close();
        esRef.current = null;
      } else if (msg.type === 'error') {
        setStatus('error');
        es.close();
        esRef.current = null;
      }
    };

    es.onerror = () => {
      if (deadRef.current) return;
      setStatus('error');
      es.close();
      esRef.current = null;
    };
  };

  const cancel = () => {
    esRef.current?.close();
    esRef.current = null;
    setStatus('idle');
    setLines([]);
  };

  return (
    <div className="modal-backdrop" onClick={(e) => { if (e.target === e.currentTarget && status !== 'running') onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="update-modal-title">

        <div className="modal-head">
          <span className="modal-title" id="update-modal-title">Update sfdt</span>
          {status !== 'running' && (
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
              <IconX size={14} />
            </button>
          )}
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-4)' }}>

          <div className="update-version-row">
            <div className="update-version-item">
              <span className="update-version-label">Current</span>
              <code className="update-version-value">v{current}</code>
            </div>
            <div className="update-version-arrow">→</div>
            <div className="update-version-item">
              <span className="update-version-label">Latest</span>
              <code className="update-version-value update-version-new">v{latest}</code>
            </div>
          </div>

          {lines.length > 0 && (
            <div className="cmd-terminal" ref={logRef} style={{ maxHeight: 260 }}>
              {lines.map(({ id, text }) => (
                <div key={id} className="cmd-line">{text || '\u00A0'}</div>
              ))}
            </div>
          )}

          {status === 'done' && (
            <div className="update-notice">
              <IconAlertTri size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                <strong>Restart required.</strong> sfdt has been updated to v{latest}.
                Close the browser tab and run <code>sfdt ui</code> again to use the new version.
              </span>
            </div>
          )}

          {status === 'error' && (
            <div className="update-notice update-notice-error">
              <IconAlertTri size={14} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>
                Update failed{exitCode != null ? ` (exit ${exitCode})` : ''}.
                You can update manually by running <code>sfdt update</code> in your terminal.
              </span>
            </div>
          )}

        </div>

        <div className="modal-foot">
          {status === 'idle' && (
            <>
              <button className="btn btn-ghost btn-sm" onClick={onClose}>Later</button>
              <button className="btn btn-primary btn-sm" onClick={startUpdate}>
                <IconDownload size={12} /> Update Now
              </button>
            </>
          )}
          {status === 'running' && (
            <>
              <div className="live-dot">installing</div>
              <button className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
            </>
          )}
          {(status === 'done' || status === 'error') && (
            <button className="btn btn-primary btn-sm" onClick={onClose}>Close</button>
          )}
        </div>

      </div>
    </div>
  );
}
