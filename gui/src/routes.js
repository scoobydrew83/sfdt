// GUI page registry — the single source of truth for page ids, labels, and
// nav grouping. Consumed by App.jsx (nav groups, breadcrumb labels, page
// routing) AND tools/generate-catalogs.mjs (plain JS on purpose: no JSX, no
// component imports, so Node can import it outside Vite).
// Adding a GUI page = one entry here + the ICONS and PAGES maps in App.jsx.
// `pageLabel` (optional) overrides `label` in the breadcrumb only.
export const GUI_ROUTES = [
  { id: 'dashboard', label: 'Dashboard', group: 'Observe' },
  { id: 'drift', label: 'Drift', group: 'Observe' },
  { id: 'audit', label: 'Org Audit', group: 'Observe' },
  { id: 'monitor', label: 'Org Monitor', group: 'Observe' },
  { id: 'tests', label: 'Test Runs', group: 'Observe' },
  { id: 'coverage', label: 'Coverage', group: 'Observe' },
  { id: 'logs', label: 'Logs', pageLabel: 'Log History', group: 'Observe' },
  { id: 'release', label: 'Release Hub', group: 'Release' },
  { id: 'manifest-builder', label: 'Manifest Builder', group: 'Release' },
  { id: 'retrofit', label: 'Retrofit', group: 'Release' },
  { id: 'compare', label: 'Compare', group: 'Analyze' },
  { id: 'scan', label: 'Scan', group: 'Analyze' },
  { id: 'preflight', label: 'Preflight', group: 'Analyze' },
  { id: 'manifests', label: 'Manifests', group: 'Analyze' },
  { id: 'quality', label: 'Quality', group: 'Analyze' },
  { id: 'agent-test', label: 'Agent Test', group: 'Analyze' },
  { id: 'pull', label: 'Pull', group: 'Analyze' },
  { id: 'review', label: 'Review', group: 'Analyze' },
  { id: 'explain', label: 'Explain', group: 'Analyze' },
  { id: 'flows', label: 'Flow Intelligence', group: 'Analyze' },
  { id: 'dependency', label: 'Dependency Graph', group: 'Analyze' },
  { id: 'soql', label: 'SOQL Console', group: 'Analyze' },
  { id: 'scratch', label: 'Scratch Orgs', group: 'Analyze' },
  { id: 'data', label: 'Data Sets', group: 'Analyze' },
  { id: 'docs', label: 'Documentation', group: 'Analyze' },
  { id: 'notifications', label: 'Notifications', group: 'Config' },
  { id: 'settings', label: 'Settings', group: 'Config' },
];

/**
 * Resolve the page to boot on from the URL path, so deep links like
 * `/manifest-builder` (built by the VS Code extension's `dashboardPageUrl`)
 * land on the right page instead of always opening the dashboard. The first
 * path segment is matched against GUI_ROUTES; anything unknown (including
 * `/`) falls back to 'dashboard'. Pure so it can be unit-tested.
 *
 * @param {string} pathname  window.location.pathname (e.g. "/audit")
 * @param {Array<{id: string}>} [routes]  route registry (defaults to GUI_ROUTES)
 * @returns {string} a valid page id
 */
export function initialPageFromPath(pathname, routes = GUI_ROUTES) {
  const segment = (pathname ?? '').replace(/^\/+/, '').split('/')[0];
  return routes.some(({ id }) => id === segment) ? segment : 'dashboard';
}
