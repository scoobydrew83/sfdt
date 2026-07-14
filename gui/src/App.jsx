import { useState, useEffect, useCallback, useMemo, createContext, useRef } from 'react';
import { api, onAuthExpired } from './api.js';
import { resolveInitialTheme } from './theme.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import Dashboard from './pages/Dashboard.jsx';
import TestRuns from './pages/TestRuns.jsx';
import PreflightPage from './pages/Preflight.jsx';
import DriftPage from './pages/Drift.jsx';
import AuditPage from './pages/Audit.jsx';
import MonitorPage from './pages/Monitor.jsx';
import ComparePage from './pages/Compare.jsx';
import ScanPage from './pages/Scan.jsx';
import ManifestsPage from './pages/Manifests.jsx';
import QualityPage from './pages/Quality.jsx';
import PullPage from './pages/Pull.jsx';
import ReleaseHubPage from './pages/ReleaseHub/index.jsx';
import ReviewPage from './pages/Review.jsx';
import ExplainPage from './pages/Explain.jsx';
import DependencyPage from './pages/Dependency.jsx';
import FlowsPage from './pages/Flows.jsx';
import SettingsPage from './pages/Settings.jsx';
import NotificationsPage from './pages/Notifications.jsx';
import LogsPage from './pages/Logs.jsx';
import CoveragePage from './pages/Coverage.jsx';
import ScratchPage from './pages/Scratch.jsx';
import DataPage from './pages/Data.jsx';
import DocsPage from './pages/Docs.jsx';
import AgentTestPage from './pages/AgentTest.jsx';
import RetrofitPage from './pages/Retrofit.jsx';
import {
  IconHome, IconList, IconCheck, IconRefresh, IconCompare,
  IconSun, IconMoon, IconFileText, IconActivity, IconCloudDown,
  IconRocket, IconCode, IconSearch, IconSettings, IconClock, IconGraph,
} from './Icons.jsx';
import UpdateModal from './components/UpdateModal.jsx';
import ChatDrawer from './components/ChatDrawer.jsx';
import { GUI_ROUTES } from './routes.js';

export const ChatContext = createContext(null);

// Per-page icon and component maps. GUI_ROUTES (routes.js) is the single
// source of truth for ids/labels/groups — these maps only bind each id to
// its JSX pieces. Adding a page = one GUI_ROUTES entry + one entry in each.
const ICONS = {
  dashboard: IconHome,
  drift: IconRefresh,
  audit: IconCheck,
  monitor: IconActivity,
  tests: IconList,
  coverage: IconActivity,
  logs: IconClock,
  release: IconRocket,
  retrofit: IconRefresh,
  compare: IconCompare,
  scan: IconList,
  preflight: IconCheck,
  manifests: IconFileText,
  quality: IconActivity,
  'agent-test': IconCheck,
  pull: IconCloudDown,
  review: IconCode,
  explain: IconSearch,
  flows: IconGraph,
  dependency: IconGraph,
  scratch: IconCloudDown,
  data: IconList,
  docs: IconFileText,
  notifications: IconActivity,
  settings: IconSettings,
};

const PAGES = {
  dashboard: Dashboard,
  drift: DriftPage,
  audit: AuditPage,
  monitor: MonitorPage,
  tests: TestRuns,
  coverage: CoveragePage,
  logs: LogsPage,
  release: ReleaseHubPage,
  retrofit: RetrofitPage,
  compare: ComparePage,
  scan: ScanPage,
  preflight: PreflightPage,
  manifests: ManifestsPage,
  quality: QualityPage,
  'agent-test': AgentTestPage,
  pull: PullPage,
  review: ReviewPage,
  explain: ExplainPage,
  flows: FlowsPage,
  dependency: DependencyPage,
  scratch: ScratchPage,
  data: DataPage,
  docs: DocsPage,
  notifications: NotificationsPage,
  settings: SettingsPage,
};

// Fail fast at module load: every route must have an icon and a component.
for (const { id } of GUI_ROUTES) {
  if (!ICONS[id]) throw new Error(`GUI route "${id}" has no entry in ICONS (App.jsx)`);
  if (!PAGES[id]) throw new Error(`GUI route "${id}" has no entry in PAGES (App.jsx)`);
}

// Grouped nav structure derived from GUI_ROUTES: each group has a label and items
const NAV_GROUPS = GUI_ROUTES.reduce((groups, { id, label, group }) => {
  if (groups.at(-1)?.label !== group) groups.push({ label: group, items: [] });
  groups.at(-1).items.push({ id, label, Icon: ICONS[id] });
  return groups;
}, []);

const PAGE_LABELS = Object.fromEntries(
  GUI_ROUTES.map(({ id, label, pageLabel }) => [id, pageLabel ?? label]));

export default function App() {
  const [page, setPage]           = useState('dashboard');
  const [project, setProject]     = useState(null);
  const [dark, setDark]           = useState(() =>
    resolveInitialTheme(window.location.search, localStorage.getItem('sfdt-theme')));
  const [updateInfo, setUpdateInfo] = useState(null);
  const [showUpdate, setShowUpdate] = useState(false);
  const [chatOpen, setChatOpen]   = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatPageContext, setChatPageContext] = useState({ page: '', data: {} });
  const [chatInitialMessage, setChatInitialMessage] = useState('');
  const [sessionOrg, setSessionOrg]   = useState(null);
  const [availableOrgs, setAvailableOrgs] = useState([]);
  const [orgPickerOpen, setOrgPickerOpen] = useState(false);
  const [authExpired, setAuthExpired] = useState(false);

  // Surface a recoverable banner when the launch-token handshake fails, instead
  // of letting every page silently render an error/empty state.
  useEffect(() => onAuthExpired(() => setAuthExpired(true)), []);
  const orgPickerRef = useRef(null);

  useEffect(() => {
    api.project().then(setProject).catch(() => null);
    api.checkUpdates().then((info) => { if (info.updateAvailable) setUpdateInfo(info); }).catch(() => null);
    api.sessionOrg().then((r) => setSessionOrg(r.org)).catch(() => null);
    api.orgs().then((r) => setAvailableOrgs(r.orgs ?? [])).catch(() => null);
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

  useEffect(() => {
    if (!orgPickerOpen) return;
    const handler = (e) => {
      if (orgPickerRef.current && !orgPickerRef.current.contains(e.target)) {
        setOrgPickerOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [orgPickerOpen]);

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
    const Page = PAGES[page] ?? Dashboard; // unknown page falls back to Dashboard
    return Page === Dashboard ? <Dashboard project={project} /> : <Page />;
  };

  const chatContextValue = useMemo(() => ({ openChat, setPageContext }), [openChat, setPageContext]);

  const initials = project?.name
    ? project.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    : 'SF';

  return (
    <ChatContext.Provider value={chatContextValue}>
    <>
    {authExpired && (
      <div role="alert" style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
        background: '#8b1a1a', color: '#fff', padding: '10px 16px',
        display: 'flex', alignItems: 'center', gap: 12,
        font: '13px/1.4 system-ui, sans-serif', boxShadow: '0 1px 6px rgba(0,0,0,0.3)',
      }}>
        <span style={{ flex: 1 }}>
          <strong>Dashboard session expired.</strong> The one-time auth token is no longer valid
          (the server was restarted, or this tab was opened without it). Reopen the URL that
          <code style={{ margin: '0 4px' }}>sfdt ui</code> printed — it carries a fresh token.
        </span>
        <button onClick={() => window.location.reload()} style={{
          background: '#fff', color: '#8b1a1a', border: 0, borderRadius: 4,
          padding: '5px 12px', fontWeight: 600, cursor: 'pointer',
        }}>Reload</button>
      </div>
    )}
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
          <div className="org-picker-wrap" ref={orgPickerRef}>
            {orgPickerOpen && (
              <div className="org-picker-dropdown">
                {availableOrgs.length === 0 && (
                  <div className="org-picker-empty">No orgs found</div>
                )}
                {availableOrgs.map((o) => (
                  <button
                    key={o.alias}
                    className={`org-picker-item${o.alias === (sessionOrg ?? project?.org) ? ' active' : ''}`}
                    onClick={() => {
                      api.setSessionOrg(o.alias)
                        .then(() => setSessionOrg(o.alias))
                        .catch(() => null);
                      setOrgPickerOpen(false);
                    }}
                  >
                    {o.alias}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="user-row" onClick={() => setOrgPickerOpen((v) => !v)} title="Click to change org">
            <div className="user-avatar">{initials}</div>
            <div className="user-info">
              <div className="user-name">
                {sessionOrg ?? project?.org ?? 'No org connected'}
                {availableOrgs.length > 0 && <span className="org-picker-caret">▾</span>}
              </div>
              <div className="user-version">
                v{project?.version ?? '…'}
                {updateInfo && (
                  <button className="update-pill" onClick={(e) => { e.stopPropagation(); setShowUpdate(true); }} title={`v${updateInfo.latest} available`}>
                    ↑ update
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </aside>

      {/* ── Main area ─────────────────────────────────────────────── */}
      <div className={`main-area${dark ? '' : ' content-light'}`}>

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
