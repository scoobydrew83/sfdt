// Flow Health Modal — vanilla DOM port of
// /Users/dkennedy/dev/2.0.2_0 copy/ui/flow-health-modal.js.
//
// The v2.0.2 modal templated its body with `innerHTML` strings and a local
// _escapeHtml helper. This port uses createElement + textContent throughout
// so labels and findings are XSS-safe by construction (no escape pathway
// needed at all). The structural sections — header / summary cards / issue
// families / metrics / footer — are preserved.

import type { IssueFamily, Rating, ScoreSummary, Severity } from '@sfdt/flow-core';

export interface HealthReportMeta {
  flowLabel: string;
  flowType: string;
  apiVersion: number | string | null;
  status: string;
}

export interface HealthReportMetrics {
  elementCount: number;
  decisionCount: number;
  loopCount: number;
  dataOperationCount: number;
  dependencyCount: number;
}

export interface HealthReport {
  meta: HealthReportMeta;
  summary: ScoreSummary & { metrics: HealthReportMetrics };
  issueFamilies: IssueFamily[];
  rawJson: string;
}

export interface HealthModalHandle {
  showLoading: (flowLabel?: string) => void;
  showError: (message: string) => void;
  showReport: (report: HealthReport) => void;
  close: () => void;
  isOpen: () => boolean;
}

const OVERLAY_ID = 'sfut-health-modal-overlay';

function styledDiv(doc: Document, className: string, cssText?: string): HTMLDivElement {
  const el = doc.createElement('div');
  el.className = className;
  if (cssText) el.style.cssText = cssText;
  return el;
}

function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function severityColour(severity: Severity): string {
  switch (severity) {
    case 'high':
      return '#c23934';
    case 'medium':
      return '#fe9339';
    case 'low':
      return '#1589ee';
    case 'info':
      return '#80868d';
  }
}

function ratingColour(rating: Rating): string {
  switch (rating) {
    case 'Excellent':
      return '#04844b';
    case 'Very Good':
      return '#2e844a';
    case 'Good':
      return '#1589ee';
    case 'Poor':
      return '#fe9339';
    case 'Very Poor':
      return '#c23934';
  }
}

export interface MountHealthModalOptions {
  doc?: Document;
  onCopyJson?: (json: string) => Promise<void> | void;
}

export function mountHealthModal(options: MountHealthModalOptions = {}): HealthModalHandle {
  const doc = options.doc ?? document;
  doc.getElementById(OVERLAY_ID)?.remove();

  const overlay = doc.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = 'sfut-modal-overlay sfut-hidden';
  overlay.style.cssText = [
    'position: fixed',
    'inset: 0',
    'background: rgba(0,0,0,0.4)',
    'z-index: 100020',
    'display: none',
    'align-items: center',
    'justify-content: center',
    'font-family: system-ui, -apple-system, sans-serif',
  ].join('; ');

  const modal = doc.createElement('div');
  modal.className = 'sfut-modal sfut-health-modal';
  modal.style.cssText = [
    'background: #fff',
    'border-radius: 4px',
    'box-shadow: 0 8px 24px rgba(0,0,0,0.3)',
    'width: 720px',
    'max-width: 90vw',
    'max-height: 90vh',
    'display: flex',
    'flex-direction: column',
  ].join('; ');

  const header = doc.createElement('div');
  header.className = 'sfut-modal-header';
  header.style.cssText =
    'padding: 12px 16px; border-bottom: 1px solid #d8dde6; display: flex; justify-content: space-between; align-items: center; font-weight: 600;';
  const headerLabel = doc.createElement('span');
  headerLabel.textContent = 'Flow Health Check';
  const closeBtn = doc.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'sfut-modal-close';
  closeBtn.textContent = '×';
  closeBtn.style.cssText =
    'background: none; border: 0; font-size: 22px; cursor: pointer; color: #80868d;';
  header.appendChild(headerLabel);
  header.appendChild(closeBtn);

  const body = doc.createElement('div');
  body.className = 'sfut-modal-body sfut-health-modal-body';
  body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';

  const footer = doc.createElement('div');
  footer.className = 'sfut-modal-footer sfut-health-modal-footer';
  footer.style.cssText =
    'padding: 12px 16px; border-top: 1px solid #d8dde6; display: flex; justify-content: flex-end; gap: 8px;';

  modal.appendChild(header);
  modal.appendChild(body);
  modal.appendChild(footer);
  overlay.appendChild(modal);
  doc.body.appendChild(overlay);

  let open = false;

  function show(): void {
    open = true;
    overlay.style.display = 'flex';
    overlay.classList.remove('sfut-hidden');
  }
  function close(): void {
    open = false;
    overlay.style.display = 'none';
    overlay.classList.add('sfut-hidden');
  }

  closeBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  function renderLoading(flowLabel: string): void {
    clear(body);
    clear(footer);
    const wrap = styledDiv(doc, 'sfut-health-loading', 'text-align: center; padding: 24px;');
    const title = doc.createElement('div');
    title.className = 'sfut-health-loading-title';
    title.style.cssText = 'font-size: 16px; font-weight: 600;';
    title.textContent = 'Running Health Check';
    const sub = doc.createElement('div');
    sub.className = 'sfut-health-loading-subtitle';
    sub.style.cssText = 'color: #80868d; margin-top: 4px;';
    sub.textContent = flowLabel;
    wrap.appendChild(title);
    wrap.appendChild(sub);
    body.appendChild(wrap);
    show();
  }

  function renderError(message: string): void {
    clear(body);
    clear(footer);
    const wrap = styledDiv(doc, 'sfut-health-error', 'padding: 16px;');
    const title = doc.createElement('div');
    title.className = 'sfut-health-section-title';
    title.style.cssText = 'font-size: 16px; font-weight: 600; color: #c23934;';
    title.textContent = 'Health Check Failed';
    const msg = doc.createElement('div');
    msg.className = 'sfut-health-error-message';
    msg.style.marginTop = '8px';
    msg.textContent = message || 'Unknown error';
    wrap.appendChild(title);
    wrap.appendChild(msg);
    body.appendChild(wrap);
    show();
  }

  function buildSummaryCard(label: string, value: number, colour: string): HTMLDivElement {
    const card = styledDiv(
      doc,
      'sfut-health-card',
      `border: 1px solid #d8dde6; border-radius: 4px; padding: 10px; text-align: center; min-width: 80px; background: #fafaf9;`,
    );
    const lbl = doc.createElement('div');
    lbl.className = 'sfut-health-card-label';
    lbl.style.cssText = `font-size: 11px; text-transform: uppercase; color: ${colour}; font-weight: 600;`;
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.className = 'sfut-health-card-value';
    val.style.cssText = 'font-size: 22px; font-weight: 700; margin-top: 4px;';
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildMetricCard(label: string, value: number): HTMLDivElement {
    const card = styledDiv(
      doc,
      'sfut-health-metric',
      'border: 1px solid #d8dde6; border-radius: 4px; padding: 8px; text-align: center; min-width: 80px;',
    );
    const lbl = doc.createElement('div');
    lbl.className = 'sfut-health-metric-label';
    lbl.style.cssText = 'font-size: 11px; color: #80868d; font-weight: 500;';
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.className = 'sfut-health-metric-value';
    val.style.cssText = 'font-size: 16px; font-weight: 600;';
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildFamilyDisclosure(family: IssueFamily): HTMLDetailsElement {
    const details = doc.createElement('details');
    details.className = 'sfut-health-family';
    details.style.cssText = 'border: 1px solid #d8dde6; border-radius: 4px; margin-bottom: 6px;';

    const summary = doc.createElement('summary');
    summary.style.cssText =
      'padding: 10px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;';

    const sevBadge = doc.createElement('span');
    sevBadge.className = `sfut-health-family-severity sfut-health-severity-${family.severity}`;
    sevBadge.style.cssText = `display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; color: #fff; background: ${severityColour(family.severity)};`;
    sevBadge.textContent = family.severity.toUpperCase();

    const titleSpan = doc.createElement('span');
    titleSpan.className = 'sfut-health-family-title';
    titleSpan.style.flex = '1';
    titleSpan.textContent = family.title;

    const countSpan = doc.createElement('span');
    countSpan.className = 'sfut-health-family-count';
    countSpan.style.cssText = 'color: #80868d; font-size: 12px;';
    countSpan.textContent = `(${family.instanceCount})`;

    summary.appendChild(sevBadge);
    summary.appendChild(titleSpan);
    summary.appendChild(countSpan);

    const familyBody = doc.createElement('div');
    familyBody.className = 'sfut-health-family-body';
    familyBody.style.cssText = 'padding: 0 12px 10px; font-size: 13px;';

    const impact = doc.createElement('div');
    impact.className = 'sfut-health-family-impact';
    impact.style.cssText = 'color: #80868d; margin-bottom: 6px;';
    impact.textContent = `Score impact: -${family.scoreImpact}`;
    familyBody.appendChild(impact);

    const list = doc.createElement('ul');
    list.className = 'sfut-health-affected-list';
    list.style.cssText = 'margin: 0; padding-left: 18px;';
    if (family.affectedItems.length === 0) {
      const li = doc.createElement('li');
      li.textContent = 'No specific items listed.';
      list.appendChild(li);
    } else {
      for (const item of family.affectedItems) {
        const li = doc.createElement('li');
        li.textContent = item.label;
        list.appendChild(li);
      }
    }
    familyBody.appendChild(list);

    details.appendChild(summary);
    details.appendChild(familyBody);
    return details;
  }

  function renderReport(report: HealthReport): void {
    clear(body);
    clear(footer);

    // Header block — flow label / meta line / score.
    const headerBlock = styledDiv(doc, 'sfut-health-header-block', 'margin-bottom: 16px;');
    const flowName = doc.createElement('div');
    flowName.className = 'sfut-health-flow-name';
    flowName.style.cssText = 'font-size: 18px; font-weight: 600;';
    flowName.textContent = report.meta.flowLabel;
    headerBlock.appendChild(flowName);

    const metaLine = doc.createElement('div');
    metaLine.className = 'sfut-health-flow-meta';
    metaLine.style.cssText = 'color: #80868d; font-size: 12px; display: flex; gap: 12px;';
    const flowTypeSpan = doc.createElement('span');
    flowTypeSpan.textContent = report.meta.flowType;
    metaLine.appendChild(flowTypeSpan);
    const apiSpan = doc.createElement('span');
    apiSpan.textContent = `API ${report.meta.apiVersion ?? 'Unknown'}`;
    metaLine.appendChild(apiSpan);
    const statusSpan = doc.createElement('span');
    statusSpan.textContent = report.meta.status || 'Unknown';
    metaLine.appendChild(statusSpan);
    headerBlock.appendChild(metaLine);

    const scoreWrap = styledDiv(
      doc,
      'sfut-health-score-wrap',
      'margin-top: 8px; display: flex; align-items: baseline; gap: 8px;',
    );
    const scoreNum = doc.createElement('div');
    scoreNum.className = 'sfut-health-score';
    scoreNum.style.cssText = `font-size: 42px; font-weight: 700; color: ${ratingColour(report.summary.rating)};`;
    scoreNum.textContent = String(report.summary.overallScore);
    const scoreRating = doc.createElement('div');
    scoreRating.className = 'sfut-health-rating';
    scoreRating.style.cssText = 'color: #54698d; font-weight: 600;';
    scoreRating.textContent = report.summary.rating;
    scoreWrap.appendChild(scoreNum);
    scoreWrap.appendChild(scoreRating);
    headerBlock.appendChild(scoreWrap);

    body.appendChild(headerBlock);

    // Severity summary card grid.
    const cards = styledDiv(
      doc,
      'sfut-health-summary-cards',
      'display: flex; gap: 8px; margin-bottom: 16px;',
    );
    cards.appendChild(buildSummaryCard('High', report.summary.severityCounts.high, severityColour('high')));
    cards.appendChild(buildSummaryCard('Medium', report.summary.severityCounts.medium, severityColour('medium')));
    cards.appendChild(buildSummaryCard('Low', report.summary.severityCounts.low, severityColour('low')));
    cards.appendChild(buildSummaryCard('Info', report.summary.severityCounts.info, severityColour('info')));
    body.appendChild(cards);

    // Issue families.
    const familiesSection = styledDiv(doc, 'sfut-health-section', 'margin-bottom: 16px;');
    const familiesTitle = doc.createElement('div');
    familiesTitle.className = 'sfut-health-section-title';
    familiesTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
    familiesTitle.textContent = 'Issue Families';
    familiesSection.appendChild(familiesTitle);
    if (report.issueFamilies.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'sfut-health-empty';
      empty.style.cssText = 'color: #80868d; font-size: 13px;';
      empty.textContent = 'No issues detected — your flow is in excellent shape.';
      familiesSection.appendChild(empty);
    } else {
      for (const family of report.issueFamilies) {
        familiesSection.appendChild(buildFamilyDisclosure(family));
      }
    }
    body.appendChild(familiesSection);

    // Flow profile metrics.
    const profileSection = styledDiv(doc, 'sfut-health-section');
    const profileTitle = doc.createElement('div');
    profileTitle.className = 'sfut-health-section-title';
    profileTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
    profileTitle.textContent = 'Flow Profile';
    profileSection.appendChild(profileTitle);
    const metricsGrid = styledDiv(
      doc,
      'sfut-health-metrics-grid',
      'display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;',
    );
    metricsGrid.appendChild(buildMetricCard('Elements', report.summary.metrics.elementCount));
    metricsGrid.appendChild(buildMetricCard('Decisions', report.summary.metrics.decisionCount));
    metricsGrid.appendChild(buildMetricCard('Loops', report.summary.metrics.loopCount));
    metricsGrid.appendChild(buildMetricCard('Data Ops', report.summary.metrics.dataOperationCount));
    metricsGrid.appendChild(buildMetricCard('Dependencies', report.summary.metrics.dependencyCount));
    profileSection.appendChild(metricsGrid);
    body.appendChild(profileSection);

    // Footer — Copy JSON button.
    const copyBtn = doc.createElement('button');
    copyBtn.className = 'sfut-health-btn';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid #d8dde6; background: #fff; border-radius: 4px; cursor: pointer;';
    copyBtn.addEventListener('click', () => {
      if (options.onCopyJson) {
        void options.onCopyJson(report.rawJson);
      } else {
        void navigator.clipboard.writeText(report.rawJson);
      }
    });
    footer.appendChild(copyBtn);

    show();
  }

  return {
    showLoading(label = 'Flow') {
      renderLoading(label);
    },
    showError: renderError,
    showReport: renderReport,
    close,
    isOpen: () => open,
  };
}
