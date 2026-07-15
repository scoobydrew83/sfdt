// createElement + textContent throughout — labels and findings are
// XSS-safe by construction with no escape pathway needed.

import type { IssueFamily, Rating, ScoreSummary, Severity } from '@sfdt/flow-core';
import { presentView, type ViewHandle } from './present-view.js';

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
      return 'var(--sfdt-color-error)';
    case 'medium':
      return 'var(--sfdt-color-warning)';
    case 'low':
      return 'var(--sfdt-color-info)';
    case 'info':
      return 'var(--sfdt-color-text-icon)';
  }
}

function ratingColour(rating: Rating): string {
  switch (rating) {
    case 'Excellent':
      return 'var(--sfdt-color-success)';
    case 'Very Good':
      return 'var(--sfdt-color-success-2)';
    case 'Good':
      return 'var(--sfdt-color-info)';
    case 'Poor':
      return 'var(--sfdt-color-warning)';
    case 'Very Poor':
      return 'var(--sfdt-color-error)';
  }
}

export interface MountHealthModalOptions {
  doc?: Document;
  onCopyJson?: (json: string) => Promise<void> | void;
}

export function mountHealthModal(options: MountHealthModalOptions = {}): HealthModalHandle {
  const doc = options.doc ?? document;

  // Owned content containers. presentView mounts these once; the render*
  // helpers swap their contents. The overlay/card/header (+ ×) chrome is
  // supplied by presentView, so the modal looks identical to every other view.
  const body = doc.createElement('div');
  body.className = 'sfdt-modal-body sfdt-health-modal-body';
  body.style.cssText = 'padding: 16px; overflow-y: auto; flex: 1;';

  const footer = doc.createElement('div');
  footer.className = 'sfdt-modal-footer sfdt-health-modal-footer';
  footer.style.cssText =
    'padding: 12px 16px; border-top: 1px solid var(--sfdt-color-border); display: flex; justify-content: flex-end; gap: 8px;';

  let view: ViewHandle | null = null;

  // Present (or re-present after a close) the owned body/footer through the
  // shared presenter. Re-presentable so a cached handle can be reopened.
  function show(): void {
    if (view) return;
    view = presentView({
      title: 'Flow Health Check',
      body,
      footer,
      doc,
      width: '720px',
      onClose: () => {
        view = null;
      },
    });
  }

  function close(): void {
    view?.close();
  }

  show();

  function renderLoading(flowLabel: string): void {
    clear(body);
    clear(footer);
    const wrap = styledDiv(doc, 'sfdt-health-loading', 'text-align: center; padding: 24px;');
    const title = doc.createElement('div');
    title.className = 'sfdt-health-loading-title';
    title.style.cssText = 'font-size: 16px; font-weight: 600;';
    title.textContent = 'Running Health Check';
    const sub = doc.createElement('div');
    sub.className = 'sfdt-health-loading-subtitle';
    sub.style.cssText = 'color: var(--sfdt-color-text-icon); margin-top: 4px;';
    sub.textContent = flowLabel;
    wrap.appendChild(title);
    wrap.appendChild(sub);
    body.appendChild(wrap);
    show();
  }

  function renderError(message: string): void {
    clear(body);
    clear(footer);
    const wrap = styledDiv(doc, 'sfdt-health-error', 'padding: 16px;');
    const title = doc.createElement('div');
    title.className = 'sfdt-health-section-title';
    title.style.cssText = 'font-size: 16px; font-weight: 600; color: var(--sfdt-color-error);';
    title.textContent = 'Health Check Failed';
    const msg = doc.createElement('div');
    msg.className = 'sfdt-health-error-message';
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
      'sfdt-health-card',
      `border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 10px; text-align: center; min-width: 80px; background: var(--sfdt-color-surface-alt);`,
    );
    const lbl = doc.createElement('div');
    lbl.className = 'sfdt-health-card-label';
    lbl.style.cssText = `font-size: 11px; text-transform: uppercase; color: ${colour}; font-weight: 600;`;
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.className = 'sfdt-health-card-value';
    val.style.cssText = 'font-size: 22px; font-weight: 700; margin-top: 4px;';
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildMetricCard(label: string, value: number): HTMLDivElement {
    const card = styledDiv(
      doc,
      'sfdt-health-metric',
      'border: 1px solid var(--sfdt-color-border); border-radius: 4px; padding: 8px; text-align: center; min-width: 80px;',
    );
    const lbl = doc.createElement('div');
    lbl.className = 'sfdt-health-metric-label';
    lbl.style.cssText = 'font-size: 11px; color: var(--sfdt-color-text-icon); font-weight: 500;';
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.className = 'sfdt-health-metric-value';
    val.style.cssText = 'font-size: 16px; font-weight: 600;';
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildFamilyDisclosure(family: IssueFamily): HTMLDetailsElement {
    const details = doc.createElement('details');
    details.className = 'sfdt-health-family';
    details.style.cssText = 'border: 1px solid var(--sfdt-color-border); border-radius: 4px; margin-bottom: 6px;';

    const summary = doc.createElement('summary');
    summary.style.cssText =
      'padding: 10px 12px; cursor: pointer; display: flex; align-items: center; gap: 8px;';

    const sevBadge = doc.createElement('span');
    sevBadge.className = `sfdt-health-family-severity sfdt-health-severity-${family.severity}`;
    sevBadge.style.cssText = `display: inline-block; padding: 2px 6px; border-radius: 3px; font-size: 10px; font-weight: 700; color: var(--sfdt-color-surface); background: ${severityColour(family.severity)};`;
    sevBadge.textContent = family.severity.toUpperCase();

    const titleSpan = doc.createElement('span');
    titleSpan.className = 'sfdt-health-family-title';
    titleSpan.style.flex = '1';
    titleSpan.textContent = family.title;

    const countSpan = doc.createElement('span');
    countSpan.className = 'sfdt-health-family-count';
    countSpan.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px;';
    countSpan.textContent = `(${family.instanceCount})`;

    summary.appendChild(sevBadge);
    summary.appendChild(titleSpan);
    summary.appendChild(countSpan);

    const familyBody = doc.createElement('div');
    familyBody.className = 'sfdt-health-family-body';
    familyBody.style.cssText = 'padding: 0 12px 10px; font-size: 13px;';

    const impact = doc.createElement('div');
    impact.className = 'sfdt-health-family-impact';
    impact.style.cssText = 'color: var(--sfdt-color-text-icon); margin-bottom: 6px;';
    impact.textContent = `Score impact: -${family.scoreImpact}`;
    familyBody.appendChild(impact);

    const list = doc.createElement('ul');
    list.className = 'sfdt-health-affected-list';
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

    const headerBlock = styledDiv(doc, 'sfdt-health-header-block', 'margin-bottom: 16px;');
    const flowName = doc.createElement('div');
    flowName.className = 'sfdt-health-flow-name';
    flowName.style.cssText = 'font-size: 18px; font-weight: 600;';
    flowName.textContent = report.meta.flowLabel;
    headerBlock.appendChild(flowName);

    const metaLine = doc.createElement('div');
    metaLine.className = 'sfdt-health-flow-meta';
    metaLine.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 12px; display: flex; gap: 12px;';
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
      'sfdt-health-score-wrap',
      'margin-top: 8px; display: flex; align-items: baseline; gap: 8px;',
    );
    const scoreNum = doc.createElement('div');
    scoreNum.className = 'sfdt-health-score';
    scoreNum.style.cssText = `font-size: 42px; font-weight: 700; color: ${ratingColour(report.summary.rating)};`;
    scoreNum.textContent = String(report.summary.overallScore);
    const scoreRating = doc.createElement('div');
    scoreRating.className = 'sfdt-health-rating';
    scoreRating.style.cssText = 'color: var(--sfdt-color-text-weak); font-weight: 600;';
    scoreRating.textContent = report.summary.rating;
    scoreWrap.appendChild(scoreNum);
    scoreWrap.appendChild(scoreRating);
    headerBlock.appendChild(scoreWrap);

    body.appendChild(headerBlock);

    const cards = styledDiv(
      doc,
      'sfdt-health-summary-cards',
      'display: flex; gap: 8px; margin-bottom: 16px;',
    );
    cards.appendChild(buildSummaryCard('High', report.summary.severityCounts.high, severityColour('high')));
    cards.appendChild(buildSummaryCard('Medium', report.summary.severityCounts.medium, severityColour('medium')));
    cards.appendChild(buildSummaryCard('Low', report.summary.severityCounts.low, severityColour('low')));
    cards.appendChild(buildSummaryCard('Info', report.summary.severityCounts.info, severityColour('info')));
    body.appendChild(cards);

    const familiesSection = styledDiv(doc, 'sfdt-health-section', 'margin-bottom: 16px;');
    const familiesTitle = doc.createElement('div');
    familiesTitle.className = 'sfdt-health-section-title';
    familiesTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
    familiesTitle.textContent = 'Issue Families';
    familiesSection.appendChild(familiesTitle);
    if (report.issueFamilies.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'sfdt-health-empty';
      empty.style.cssText = 'color: var(--sfdt-color-text-icon); font-size: 13px;';
      empty.textContent = 'No issues detected — your flow is in excellent shape.';
      familiesSection.appendChild(empty);
    } else {
      for (const family of report.issueFamilies) {
        familiesSection.appendChild(buildFamilyDisclosure(family));
      }
    }
    body.appendChild(familiesSection);

    const profileSection = styledDiv(doc, 'sfdt-health-section');
    const profileTitle = doc.createElement('div');
    profileTitle.className = 'sfdt-health-section-title';
    profileTitle.style.cssText = 'font-weight: 600; margin-bottom: 8px;';
    profileTitle.textContent = 'Flow Profile';
    profileSection.appendChild(profileTitle);
    const metricsGrid = styledDiv(
      doc,
      'sfdt-health-metrics-grid',
      'display: grid; grid-template-columns: repeat(5, 1fr); gap: 6px;',
    );
    metricsGrid.appendChild(buildMetricCard('Elements', report.summary.metrics.elementCount));
    metricsGrid.appendChild(buildMetricCard('Decisions', report.summary.metrics.decisionCount));
    metricsGrid.appendChild(buildMetricCard('Loops', report.summary.metrics.loopCount));
    metricsGrid.appendChild(buildMetricCard('Data Ops', report.summary.metrics.dataOperationCount));
    metricsGrid.appendChild(buildMetricCard('Dependencies', report.summary.metrics.dependencyCount));
    profileSection.appendChild(metricsGrid);
    body.appendChild(profileSection);

    const copyBtn = doc.createElement('button');
    copyBtn.className = 'sfdt-health-btn';
    copyBtn.textContent = 'Copy JSON';
    copyBtn.style.cssText =
      'padding: 6px 12px; border: 1px solid var(--sfdt-color-border); background: var(--sfdt-color-surface); border-radius: 4px; cursor: pointer;';
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
    isOpen: () => view !== null,
  };
}
