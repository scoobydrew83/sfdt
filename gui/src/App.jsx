import { useState, useEffect } from 'react';
import { api } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import TestRuns from './pages/TestRuns.jsx';
import PreflightPage from './pages/Preflight.jsx';
import DriftPage from './pages/Drift.jsx';
import ComparePage from './pages/Compare.jsx';
import {
  IconHome, IconList, IconCheck, IconRefresh, IconCompare,
  IconSun, IconMoon,
} from './Icons.jsx';

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard',       Icon: IconHome },
  { id: 'tests',     label: 'Test Runs',        Icon: IconList },
  { id: 'preflight', label: 'Preflight',        Icon: IconCheck },
  { id: 'drift',     label: 'Drift',            Icon: IconRefresh },
  { id: 'compare',   label: 'Compare',          Icon: IconCompare },
];

const PAGE_LABELS = {
  dashboard: 'Dashboard',
  tests:     'Test Runs',
  preflight: 'Preflight',
  drift:     'Drift',
  compare:   'Compare',
};

export default function App() {
  const [page, setPage]       = useState('dashboard');
  const [project, setProject] = useState(null);
  const [dark, setDark]       = useState(false);

  useEffect(() => {
    api.project().then(setProject).catch(() => null);
    const saved = localStorage.getItem('sfdt-theme');
    if (saved === 'dark') setDark(true);
  }, []);

  const toggleDark = () => {
    setDark((d) => {
      const next = !d;
      localStorage.setItem('sfdt-theme', next ? 'dark' : 'light');
      return next;
    });
  };

  const renderPage = () => {
    switch (page) {
      case 'dashboard': return <Dashboard project={project} />;
      case 'tests':     return <TestRuns />;
      case 'preflight': return <PreflightPage />;
      case 'drift':     return <DriftPage />;
      case 'compare':   return <ComparePage />;
      default:          return <Dashboard project={project} />;
    }
  };

  const initials = project?.name
    ? project.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : 'SF';

  return (
    <div className="app-shell">

      {/* ── Sidebar ──────────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <div className="brand-mark">
            <div className="brand-icon">SF</div>
            <div>
              <div className="brand-name">sfdt</div>
              <span className="brand-sub">{project?.name ?? 'Salesforce DevTools'}</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          <div className="nav-group-title">Navigation</div>
          {NAV_ITEMS.map(({ id, label, Icon }) => (
            <button
              key={id}
              className={`nav-item${page === id ? ' active' : ''}`}
              onClick={() => setPage(id)}
              aria-current={page === id ? 'page' : undefined}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-row">
            <div className="user-avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">{project?.org ?? 'No org connected'}</div>
              <div className="user-version">v{project?.version ?? '…'}</div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────── */}
      <div className={`main-area${dark ? ' content-dark' : ''}`}>

        {/* Top bar */}
        <header className="topbar">
          <nav className="topbar-crumbs">
            <span>sfdt</span>
            <span className="sep">/</span>
            <span className="current">{PAGE_LABELS[page]}</span>
          </nav>
          <div className="topbar-spacer" />
          <div className="topbar-actions">
            <button className="theme-toggle" onClick={toggleDark} type="button">
              {dark ? <IconSun size={13} /> : <IconMoon size={13} />}
              {dark ? 'Light' : 'Dark'}
            </button>
          </div>
        </header>

        {/* Page content */}
        <div className="page-content">
          {renderPage()}
        </div>

      </div>
    </div>
  );
}
