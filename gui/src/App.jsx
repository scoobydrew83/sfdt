import React, { useState, useEffect } from 'react';
import IconSettings from '@salesforce/design-system-react/components/icon-settings';
import Icon from '@salesforce/design-system-react/components/icon';
import { api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import TestRuns from './pages/TestRuns.jsx';
import PreflightPage from './pages/Preflight.jsx';
import DriftPage from './pages/Drift.jsx';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard',       icon: 'home' },
  { id: 'tests',     label: 'Test Runs',        icon: 'list' },
  { id: 'preflight', label: 'Preflight',        icon: 'check' },
  { id: 'drift',     label: 'Drift Detection',  icon: 'refresh' },
];

export default function App() {
  const [page, setPage] = useState('dashboard');
  const [project, setProject] = useState(null);

  useEffect(() => {
    api.project().then(setProject).catch(() => null);
  }, []);

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard project={project} />;
      case 'tests':     return <TestRuns />;
      case 'preflight': return <PreflightPage />;
      case 'drift':     return <DriftPage />;
      default:          return <Dashboard project={project} />;
    }
  };

  return (
    <IconSettings iconPath="/assets/icons">
      <div className="slds-grid slds-nowrap" style={{ height: '100vh' }}>

        {/* ── Left navigation panel ─────────────────────────────────────── */}
        <aside
          className="slds-col slds-no-flex"
          style={{ width: '240px', background: '#032d60', display: 'flex', flexDirection: 'column' }}
        >
          {/* Project / app header */}
          <div
            className="slds-media slds-media_center slds-p-around_medium"
            style={{ borderBottom: '1px solid rgba(255,255,255,0.15)', flexShrink: 0 }}
          >
            <div className="slds-media__body">
              <p
                className="slds-text-body_small slds-m-bottom_xx-small"
                style={{ color: 'rgba(255,255,255,0.55)', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}
              >
                Salesforce DevTools
              </p>
              <p
                className="slds-text-heading_small slds-truncate"
                style={{ color: '#fff' }}
                title={project?.name ?? 'SFDT'}
              >
                {project?.name ?? 'SFDT'}
              </p>
              {project?.org && (
                <p
                  className="slds-text-body_small slds-truncate"
                  style={{ color: 'rgba(255,255,255,0.55)' }}
                  title={project.org}
                >
                  {project.org}
                </p>
              )}
            </div>
          </div>

          {/* Vertical navigation */}
          <nav className="slds-nav-vertical" style={{ flex: 1, paddingTop: '8px' }}>
            <div className="slds-nav-vertical__section">
              <ul>
                {NAV_ITEMS.map((item) => {
                  const active = page === item.id;
                  return (
                    <li
                      key={item.id}
                      className={`slds-nav-vertical__item${active ? ' slds-is-active' : ''}`}
                    >
                      <a
                        href="#"
                        className="slds-nav-vertical__action"
                        aria-current={active ? 'page' : undefined}
                        onClick={(e) => { e.preventDefault(); setPage(item.id); }}
                        style={{
                          color: active ? '#fff' : 'rgba(255,255,255,0.72)',
                          background: active ? 'rgba(255,255,255,0.12)' : 'transparent',
                          borderLeft: active ? '3px solid #1b96ff' : '3px solid transparent',
                          paddingLeft: '13px',
                        }}
                      >
                        <span className="slds-media slds-media_center slds-media_small">
                          <span className="slds-media__figure">
                            <Icon
                              assistiveText={{ label: item.label }}
                              category="utility"
                              name={item.icon}
                              size="x-small"
                              colorVariant="light"
                            />
                          </span>
                          <span className="slds-media__body">{item.label}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            </div>
          </nav>

          {/* Footer */}
          <div
            className="slds-p-around_small slds-text-body_small"
            style={{ borderTop: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.4)', flexShrink: 0 }}
          >
            sfdt v{project?.version ?? '…'}
          </div>
        </aside>

        {/* ── Main content ──────────────────────────────────────────────── */}
        <main className="slds-col" style={{ flex: 1, overflow: 'auto', background: '#f3f3f3' }}>
          {renderPage()}
        </main>

      </div>
    </IconSettings>
  );
}
