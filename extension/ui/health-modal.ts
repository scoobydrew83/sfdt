// createElement + textContent throughout — labels and findings are
// XSS-safe by construction with no escape pathway needed.

import type { IssueFamily, Rating, ScoreSummary, Severity } from '@sfdt/flow-core';
import { presentView, type ViewHandle } from './present-view.js';
import { button, setTone, toolbar, type Tone } from '../lib/ui-controls.js';
import { copyToClipboard } from './clipboard.js';

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

/**
 * A block with an identity class the tests query BY NAME, plus whatever
 * component classes carry its look.
 *
 * `classList.add` rather than assigning `.className`: a bulk pass in this
 * codebase once wiped five identity classes by assigning over them, and only a
 * test querying a class by name caught it.
 */
function block(doc: Document, ...classes: string[]): HTMLDivElement {
  const el = doc.createElement('div');
  el.classList.add(...classes);
  return el;
}

function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

/**
 * Severity → tone, for TEXT.
 *
 * These used to return `var(--sfdt-color-error)` and friends, which are FILL
 * tokens, and they were being written to `.style.color` — the exact
 * foreground/fill inversion CLAUDE.md rule 3 exists to stop. It renders
 * low-contrast in dark mode. `setTone` resolves to the `-text` variants.
 */
function severityTone(severity: Severity): Tone {
  switch (severity) {
    case 'high':
      return 'bad';
    case 'medium':
      return 'warn';
    case 'low':
      return 'info';
    case 'info':
      return 'muted';
  }
}

/** Severity → pill variant, for a FILL. Low and info stay the neutral pill. */
function severityPillClass(severity: Severity): string | null {
  if (severity === 'high') return 'sfdt-error';
  if (severity === 'medium') return 'sfdt-warning';
  return null;
}

function ratingTone(rating: Rating): Tone {
  switch (rating) {
    case 'Excellent':
    case 'Very Good':
      return 'ok';
    case 'Good':
      return 'info';
    case 'Poor':
      return 'warn';
    case 'Very Poor':
      return 'bad';
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
  body.className = 'sfdt-view-main sfdt-modal-body sfdt-health-modal-body';
  // The footer strip is `toolbar(doc, foot)` — the same bordered, right-aligned
  // action row every other view's footer uses.
  const footer = toolbar(doc, true);
  footer.classList.add('sfdt-modal-footer', 'sfdt-health-modal-footer');

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
    const wrap = block(doc, 'sfdt-health-loading', 'sfdt-stack', 'sfdt-tight');
    const title = doc.createElement('div');
    title.className = 'sfdt-health-loading-title sfdt-subhead';
    title.textContent = 'Running Health Check';
    const sub = doc.createElement('div');
    sub.className = 'sfdt-health-loading-subtitle';
    sub.classList.add('sfdt-faint');
    sub.textContent = flowLabel;
    wrap.appendChild(title);
    wrap.appendChild(sub);
    body.appendChild(wrap);
    show();
  }

  function renderError(message: string): void {
    clear(body);
    clear(footer);
    const wrap = block(doc, 'sfdt-health-error', 'sfdt-stack', 'sfdt-tight');
    const title = doc.createElement('div');
    title.className = 'sfdt-health-section-title';
    title.classList.add('sfdt-subhead');
    title.textContent = 'Health Check Failed';
    const msg = doc.createElement('div');
    // flow-health-check hands this a Tooling error's `.message`, which since
    // lib/sf-error-guidance.ts carries the org's text and the "what to do" line
    // separated by a newline. `.sfdt-msg` is the sheet's white-space rule —
    // test/error-render-newlines.test.ts derives the qualifying class names from
    // SFDT_COMPONENT_CSS, so it can never vouch for a class whose declaration
    // has been deleted.
    msg.classList.add('sfdt-health-error-message', 'sfdt-msg');
    msg.textContent = message || 'Unknown error';
    wrap.appendChild(title);
    wrap.appendChild(msg);
    body.appendChild(wrap);
    show();
  }

  // Both card shapes are '.sfdt-tile' — the same card the Workspace overview,
  // the org-limit strip and the Apex governor tiles use. They were three
  // independent borders at two radii and three paddings for one shape.
  function buildSummaryCard(label: string, value: number, severity: Severity): HTMLDivElement {
    const card = block(doc, 'sfdt-health-card', 'sfdt-tile');
    const lbl = doc.createElement('div');
    lbl.classList.add('sfdt-health-card-label', 'sfdt-tile-label');
    // Tone on the LABEL, not the number: the count is the datum and stays in the
    // body colour, while the severity it belongs to is what carries the meaning.
    setTone(lbl, severityTone(severity));
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.classList.add('sfdt-health-card-value', 'sfdt-tile-value');
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildMetricCard(label: string, value: number): HTMLDivElement {
    const card = block(doc, 'sfdt-health-metric', 'sfdt-tile');
    const lbl = doc.createElement('div');
    lbl.classList.add('sfdt-health-metric-label', 'sfdt-tile-label');
    lbl.textContent = label;
    const val = doc.createElement('div');
    val.classList.add('sfdt-health-metric-value', 'sfdt-tile-value');
    val.textContent = String(value);
    card.appendChild(lbl);
    card.appendChild(val);
    return card;
  }

  function buildFamilyDisclosure(family: IssueFamily): HTMLDetailsElement {
    const details = doc.createElement('details');
    // '.sfdt-panel' is the sheet's bordered block-inside-a-pane; '.sfdt-below'
    // is its trailing rhythm. Both replace the border/radius/margin string.
    details.classList.add('sfdt-health-family', 'sfdt-panel', 'sfdt-below');

    const summary = doc.createElement('summary');
    summary.classList.add('sfdt-row', 'sfdt-snug');

    const sevBadge = doc.createElement('span');
    sevBadge.classList.add(
      'sfdt-health-family-severity',
      `sfdt-health-severity-${family.severity}`,
      'sfdt-pill',
    );
    // The pill variants own the fill/foreground pairing. Low and info get the
    // neutral pill rather than a fourth colour — three severities already carry
    // colour and a fourth stops reading as a scale.
    const pillVariant = severityPillClass(family.severity);
    if (pillVariant) sevBadge.classList.add(pillVariant);
    sevBadge.textContent = family.severity.toUpperCase();

    const titleSpan = doc.createElement('span');
    titleSpan.className = 'sfdt-health-family-title';
    titleSpan.classList.add('sfdt-grow');
    titleSpan.textContent = family.title;

    const countSpan = doc.createElement('span');
    countSpan.className = 'sfdt-health-family-count sfdt-faint';
    countSpan.textContent = `(${family.instanceCount})`;

    summary.appendChild(sevBadge);
    summary.appendChild(titleSpan);
    summary.appendChild(countSpan);

    const familyBody = doc.createElement('div');
    familyBody.classList.add('sfdt-health-family-body');

    const impact = doc.createElement('div');
    impact.className = 'sfdt-health-family-impact';
    impact.classList.add('sfdt-faint');
    impact.textContent = `Score impact: -${family.scoreImpact}`;
    familyBody.appendChild(impact);

    const list = doc.createElement('ul');
    list.className = 'sfdt-health-affected-list';
    list.classList.add('sfdt-list', 'sfdt-flush-x');
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

    const headerBlock = block(doc, 'sfdt-health-header-block', 'sfdt-below');
    const flowName = doc.createElement('div');
    flowName.className = 'sfdt-health-flow-name sfdt-subhead';
    flowName.textContent = report.meta.flowLabel;
    headerBlock.appendChild(flowName);

    const metaLine = doc.createElement('div');
    metaLine.className = 'sfdt-health-flow-meta';
    metaLine.classList.add('sfdt-row');
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

    const scoreWrap = block(doc, 'sfdt-health-score-wrap', 'sfdt-row', 'sfdt-baseline', 'sfdt-snug');
    const scoreNum = doc.createElement('div');
    scoreNum.classList.add('sfdt-health-score');
    // The one genuinely single-site declaration left in this file: a hero
    // number, at the sheet's metric size. The COLOUR is a tone class — it was a
    // fill token written to `.style.color`, which renders low-contrast in dark.
    scoreNum.style.cssText = 'font: var(--sfdt-type-metric);';
    setTone(scoreNum, ratingTone(report.summary.rating));
    scoreNum.textContent = String(report.summary.overallScore);
    const scoreRating = doc.createElement('div');
    scoreRating.className = 'sfdt-health-rating';
    scoreRating.classList.add('sfdt-label');
    scoreRating.textContent = report.summary.rating;
    scoreWrap.appendChild(scoreNum);
    scoreWrap.appendChild(scoreRating);
    headerBlock.appendChild(scoreWrap);

    body.appendChild(headerBlock);

    // '.sfdt-tiles' is the auto-fit grid, so the strip is 4-across in the
    // Workspace pane and 2-across in the 720px modal without a media query.
    const cards = block(doc, 'sfdt-health-summary-cards', 'sfdt-tiles', 'sfdt-below');
    cards.appendChild(buildSummaryCard('High', report.summary.severityCounts.high, 'high'));
    cards.appendChild(buildSummaryCard('Medium', report.summary.severityCounts.medium, 'medium'));
    cards.appendChild(buildSummaryCard('Low', report.summary.severityCounts.low, 'low'));
    cards.appendChild(buildSummaryCard('Info', report.summary.severityCounts.info, 'info'));
    body.appendChild(cards);

    const familiesSection = block(doc, 'sfdt-health-section', 'sfdt-below');
    const familiesTitle = doc.createElement('div');
    familiesTitle.className = 'sfdt-health-section-title';
    familiesTitle.classList.add('sfdt-subhead');
    familiesTitle.textContent = 'Issue Families';
    familiesSection.appendChild(familiesTitle);
    if (report.issueFamilies.length === 0) {
      const empty = doc.createElement('div');
      empty.className = 'sfdt-health-empty sfdt-faint';
      empty.textContent = 'No issues detected — your flow is in excellent shape.';
      familiesSection.appendChild(empty);
    } else {
      for (const family of report.issueFamilies) {
        familiesSection.appendChild(buildFamilyDisclosure(family));
      }
    }
    body.appendChild(familiesSection);

    const profileSection = block(doc, 'sfdt-health-section');
    const profileTitle = doc.createElement('div');
    profileTitle.className = 'sfdt-health-section-title';
    profileTitle.classList.add('sfdt-subhead');
    profileTitle.textContent = 'Flow Profile';
    profileSection.appendChild(profileTitle);
    // Auto-fit rather than the old fixed `repeat(5, 1fr)`: five 1fr columns in a
    // 720px modal is a 130px cell holding "Dependencies", which wrapped to three
    // lines and pushed the number it labelled out of view.
    const metricsGrid = block(doc, 'sfdt-health-metrics-grid', 'sfdt-tiles');
    metricsGrid.appendChild(buildMetricCard('Elements', report.summary.metrics.elementCount));
    metricsGrid.appendChild(buildMetricCard('Decisions', report.summary.metrics.decisionCount));
    metricsGrid.appendChild(buildMetricCard('Loops', report.summary.metrics.loopCount));
    metricsGrid.appendChild(buildMetricCard('Data Ops', report.summary.metrics.dataOperationCount));
    metricsGrid.appendChild(buildMetricCard('Dependencies', report.summary.metrics.dependencyCount));
    profileSection.appendChild(metricsGrid);
    body.appendChild(profileSection);

    const copyBtn = button({ label: 'Copy JSON', iconName: 'clipboard', doc });
    copyBtn.classList.add('sfdt-health-btn', 'sfdt-toolbar-end');
    copyBtn.addEventListener('click', () => {
      if (options.onCopyJson) {
        void options.onCopyJson(report.rawJson);
      } else {
        void copyToClipboard(report.rawJson, { doc });
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
