import { useState, useEffect, useCallback, createContext } from 'react';
import { api } from './api.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TestRuns from './pages/TestRuns.jsx';
import PreflightPage from './pages/Preflight.jsx';
import DriftPage from './pages/Drift.jsx';
import ComparePage from './pages/Compare.jsx';
import ManifestsPage from './pages/Manifests.jsx';
import QualityPage from './pages/Quality.jsx';
import PullPage from './pages/Pull.jsx';
import ReleaseHubPage from './pages/ReleaseHub.jsx';
import ReviewPage from './pages/Review.jsx';
import ExplainPage from './pages/Explain.jsx';
import SettingsPage from './pages/Settings.jsx';
import LogsPage from './pages/Logs.jsx';
import {
  IconHome, IconList, IconCheck, IconRefresh, IconCompare,
  IconSun, IconMoon, IconFileText, IconActivity, IconCloudDown,
  IconRocket, IconCode, IconSearch, IconSettings, IconClock,
} from './Icons.jsx';
import UpdateModal from './components/UpdateModal.jsx';
import ChatDrawer from './components/ChatDrawer.jsx';

export const ChatContext = createContext(null);

// Grouped nav structure: each group has a label and items
const NAV_GROUPS = [
  {
    label: 'Observe',
    items: [
      { id: 'dashboard', label: 'Dashboard', Icon: IconHome },
      { id: 'drift',     label: 'Drift',     Icon: IconRefresh },
      { id: 'tests',     label: 'Test Runs', Icon: IconList },
      { id: 'logs',      label: 'Logs',      Icon: IconClock },
    ],
  },
  {
    label: 'Release',
    items: [
      { id: 'release',   label: 'Release Hub', Icon: IconRocket },
    ],
  },
  {
    label: 'Analyze',
    items: [
      { id: 'compare',   label: 'Compare',   Icon: IconCompare },
      { id: 'preflight', label: 'Preflight', Icon: IconCheck },
      { id: 'manifests', label: 'Manifests', Icon: IconFileText },
      { id: 'quality',   label: 'Quality',   Icon: IconActivity },
      { id: 'pull',      label: 'Pull',      Icon: IconCloudDown },
      { id: 'review',    label: 'Review',    Icon: IconCode },
      { id: 'explain',   label: 'Explain',   Icon: IconSearch },
    ],
  },
  {
    label: 'Config',
    items: [
      { id: 'settings',  label: 'Settings',  Icon: IconSettings },
    ],
  },
];

const PAGE_LABELS = {
  dashboard: 'Dashboard',
  tests:     'Test Runs',
  preflight: 'Preflight',
  drift:     'Drift',
  compare:   'Compare',
  manifests: 'Manifests',
  quality:   'Quality',
  pull:      'Pull',
  release:   'Release Hub',
  review:    'Review',
  explain:   'Explain',
  logs:      'Log History',
  settings:  'Settings',
};

export default function App() {
  const [page, setPage]           = useState('dashboard');
  const [project, setProject]     = useState(null);
  const [dark, setDark]           = useState(false);
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [chatOpen, setChatOpen]   = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatPageContext, setChatPageContext] = useState({ page: '', data: {} });
  const [chatInitialMessage, setChatInitialMessage] = useState('');

  useEffect(() => {
    api.project().then(setProject).catch(() => null);
    api.checkUpdates().then((info) => { if (info.updateAvailable) setUpdateInfo(info); }).catch(() => null);
    const saved = localStorage.getItem('sfdt-theme');
    if (saved === 'dark') setDark(true);
  }, []);

  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'A') {
        setChatOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const openChat = useCallback((initialMessage = '') => {
    setChatInitialMessage(initialMessage);
    setChatOpen(true);
  }, []);

  const setPageContext = useCallback((ctx) => {
    setChatPageContext(ctx);
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
      case 'manifests': return <ManifestsPage />;
      case 'quality':   return <QualityPage />;
      case 'pull':      return <PullPage />;
      case 'release':   return <ReleaseHubPage />;
      case 'review':    return <ReviewPage />;
      case 'explain':   return <ExplainPage />;
      case 'logs':      return <LogsPage />;
      case 'settings':  return <SettingsPage />;
      default:          return <Dashboard project={project} />;
    }
  };

  const initials = project?.name
    ? project.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : 'SF';

  return (
    <ChatContext.Provider value={{ openChat, setPageContext }}>
    <>
    {showUpdate && updateInfo && (
      <UpdateModal
        current={updateInfo.current}
        latest={updateInfo.latest}
        onClose={() => setShowUpdate(false)}
      />
    )}
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
          {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <div className="nav-group-title">{group.label}</div>
              {group.items.map(({ id, label, Icon }) => (
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
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-row">
            <div className="user-avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">{project?.org ?? 'No org connected'}</div>
              <div className="user-version">
                v{project?.version ?? '…'}
                {updateInfo && (
                  <button className="update-pill" onClick={() => setShowUpdate(true)} title={`v${updateInfo.latest} available`}>
                    ↑ update
                  </button>
                )}
              </div>
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
          <ErrorBoundary key={page}>
            {renderPage()}
          </ErrorBoundary>
        </div>

      </div>
    </div>
    <ChatDrawer
      isOpen={chatOpen}
      onClose={() => setChatOpen(false)}
      pageContext={chatPageContext}
      messages={chatMessages}
      onMessagesChange={setChatMessages}
      initialMessage={chatInitialMessage}
    />
    </>
    </ChatContext.Provider>
  );
}
