import React, { useState, useEffect } from 'react';
import IconSettings from '@salesforce/design-system-react/components/icon-settings';
import { api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import TestRuns from './pages/TestRuns.jsx';
import PreflightPage from './pages/Preflight.jsx';
import DriftPage from './pages/Drift.jsx';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '⚡' },
  { id: 'tests', label: 'Test Runs', icon: '✓' },
  { id: 'preflight', label: 'Preflight', icon: '🔍' },
  { id: 'drift', label: 'Drift Detection', icon: '⚖' },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [project, setProject] = useState(null);

  useEffect(() => {
    api.project().then(setProject).catch(() => null);
  }, []);

  const renderPage = () => {
    switch (page) {
      case 'dashboard':
        return <Dashboard project={project} />;
      case 'tests':
        return <TestRuns />;
      case 'preflight':
        return <PreflightPage />;
      case 'drift':
        return <DriftPage />;
      default:
        return <Dashboard project={project} />;
    }
  };

  return (
    <IconSettings iconPath="/assets/icons">
      <div className="slds-grid slds-nowrap" style={{ height: '100vh' }}>
        {/* Sidebar */}
        <aside
          className="slds-col slds-no-flex"
          style={{
            width: '220px',
            background: '#032d60',
            color: '#fff',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* Logo / App Name */}
          <div
            style={{
              padding: '20px 16px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.15)',
            }}
          >
            <div
              style={{
                fontSize: '11px',
                fontWeight: 700,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: 'rgba(255,255,255,0.6)',
                marginBottom: '4px',
              }}
            >
              Salesforce DevTools
            </div>
            <div style={{ fontSize: '16px', fontWeight: 700, color: '#fff' }}>
              {project?.name ?? 'SFDT'}
            </div>
            {project?.org && (
              <div
                style={{
                  fontSize: '12px',
                  color: 'rgba(255,255,255,0.55)',
                  marginTop: '2px',
                }}
              >
                {project.org}
              </div>
            )}
          </div>

          {/* Nav */}
          <nav style={{ flex: 1, padding: '8px 0' }}>
            {NAV_ITEMS.map((item) => (
              <button
                key={item.id}
                onClick={() => setPage(item.id)}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  background: page === item.id ? 'rgba(255,255,255,0.12)' : 'transparent',
                  border: 'none',
                  borderLeft: page === item.id ? '3px solid #1b96ff' : '3px solid transparent',
                  color: page === item.id ? '#fff' : 'rgba(255,255,255,0.72)',
                  padding: '10px 16px 10px 13px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '10px',
                  transition: 'background 0.1s',
                }}
                onMouseEnter={(e) => {
                  if (page !== item.id)
                    e.currentTarget.style.background = 'rgba(255,255,255,0.07)';
                }}
                onMouseLeave={(e) => {
                  if (page !== item.id) e.currentTarget.style.background = 'transparent';
                }}
              >
                <span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>
                  {item.icon}
                </span>
                {item.label}
              </button>
            ))}
          </nav>

          {/* Footer */}
          <div
            style={{
              padding: '12px 16px',
              borderTop: '1px solid rgba(255,255,255,0.12)',
              fontSize: '11px',
              color: 'rgba(255,255,255,0.4)',
            }}
          >
            sfdt v{project?.version ?? '…'}
          </div>
        </aside>

        {/* Main */}
        <main className="slds-col" style={{ flex: 1, overflow: 'auto', background: '#f3f3f3' }}>
          {renderPage()}
        </main>
      </div>
    </IconSettings>
  );
}
