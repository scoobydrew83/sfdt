import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mountHealthModal, type HealthReport } from '../ui/health-modal.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

beforeEach(() => {
  clearBody();
  setWorkspaceViewSink(null);
});

function makeReport(overrides: Partial<HealthReport> = {}): HealthReport {
  const base = {
    meta: {
      flowLabel: 'My Flow',
      flowType: 'AutoLaunchedFlow',
      apiVersion: 62,
      status: 'Active',
    },
    summary: {
      overallScore: 84,
      rating: 'Very Good',
      severityCounts: { high: 1, medium: 2, low: 3, info: 4 },
      metrics: {
        elementCount: 10,
        decisionCount: 2,
        loopCount: 1,
        dataOperationCount: 3,
        dependencyCount: 5,
      },
    },
    issueFamilies: [
      {
        severity: 'high',
        title: 'Hardcoded Ids',
        instanceCount: 2,
        scoreImpact: 8,
        affectedItems: [{ label: 'Get_Account' }, { label: 'Update_Case' }],
      },
    ],
    rawJson: '{"flow":"raw"}',
  };
  return { ...base, ...overrides } as unknown as HealthReport;
}

describe('health-modal — open/close state machine', () => {
  it('presents an open overlay on mount', () => {
    const handle = mountHealthModal();
    const overlay = document.querySelector('.sfdt-view-overlay') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    expect(handle.isOpen()).toBe(true);
    expect(overlay!.style.display).toContain('flex');
  });

  it('swaps content in place without stacking overlays', () => {
    const handle = mountHealthModal();
    handle.showLoading('Order Flow');
    handle.showReport(makeReport());
    expect(document.querySelectorAll('.sfdt-view-overlay')).toHaveLength(1);
  });

  it('showLoading shows the modal with the flow label', () => {
    const handle = mountHealthModal();
    handle.showLoading('Order Flow');
    expect(handle.isOpen()).toBe(true);
    expect(document.querySelector('.sfdt-view-overlay')).not.toBeNull();
    expect(document.querySelector('.sfdt-health-loading-subtitle')?.textContent).toBe('Order Flow');
  });

  it('showLoading defaults the label to "Flow"', () => {
    const handle = mountHealthModal();
    handle.showLoading();
    expect(document.querySelector('.sfdt-health-loading-subtitle')?.textContent).toBe('Flow');
  });

  it('the close button closes and removes the overlay', () => {
    const handle = mountHealthModal();
    handle.showLoading('x');
    document.querySelector<HTMLButtonElement>('.sfdt-view-overlay button[aria-label="Close"]')!.click();
    expect(handle.isOpen()).toBe(false);
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
  });

  it('clicking the overlay backdrop closes, but clicking the modal body does not', () => {
    const handle = mountHealthModal();
    handle.showLoading('x');
    document.querySelector<HTMLElement>('.sfdt-health-modal-body')!.click();
    expect(handle.isOpen()).toBe(true);
    (document.querySelector('.sfdt-view-overlay') as HTMLElement).click();
    expect(handle.isOpen()).toBe(false);
  });

  it('close() can be called directly', () => {
    const handle = mountHealthModal();
    handle.showLoading('x');
    handle.close();
    expect(handle.isOpen()).toBe(false);
  });

  it('reopens after close when the cached handle is reused', () => {
    const handle = mountHealthModal();
    handle.close();
    expect(handle.isOpen()).toBe(false);
    handle.showReport(makeReport());
    expect(handle.isOpen()).toBe(true);
    expect(document.querySelector('.sfdt-health-flow-name')?.textContent).toBe('My Flow');
  });
});

describe('health-modal — showError', () => {
  it('renders the error message', () => {
    const handle = mountHealthModal();
    handle.showError('Network timeout');
    expect(handle.isOpen()).toBe(true);
    expect(document.querySelector('.sfdt-health-error-message')?.textContent).toBe('Network timeout');
  });

  it('falls back to "Unknown error" for an empty message', () => {
    const handle = mountHealthModal();
    handle.showError('');
    expect(document.querySelector('.sfdt-health-error-message')?.textContent).toBe('Unknown error');
  });
});

describe('health-modal — showReport', () => {
  it('renders flow meta, score, severity cards and metrics', () => {
    const handle = mountHealthModal();
    handle.showReport(makeReport());
    expect(document.querySelector('.sfdt-health-flow-name')?.textContent).toBe('My Flow');
    expect(document.querySelector('.sfdt-health-score')?.textContent).toBe('84');
    expect(document.querySelector('.sfdt-health-rating')?.textContent).toBe('Very Good');
    // Four severity summary cards.
    expect(document.querySelectorAll('.sfdt-health-card')).toHaveLength(4);
    expect(document.querySelector('.sfdt-health-card-value')?.textContent).toBe('1'); // high count
    // Five profile metric cards.
    expect(document.querySelectorAll('.sfdt-health-metric')).toHaveLength(5);
  });

  it('renders "API Unknown" when the api version is null', () => {
    const handle = mountHealthModal();
    const report = makeReport();
    (report.meta as { apiVersion: unknown }).apiVersion = null;
    handle.showReport(report);
    expect(document.querySelector('.sfdt-health-flow-meta')?.textContent).toContain('API Unknown');
  });

  it('renders an issue family with its affected items', () => {
    const handle = mountHealthModal();
    handle.showReport(makeReport());
    const family = document.querySelector('.sfdt-health-family')!;
    expect(family.querySelector('.sfdt-health-family-title')?.textContent).toBe('Hardcoded Ids');
    expect(family.querySelector('.sfdt-health-family-severity')?.textContent).toBe('HIGH');
    expect(family.querySelector('.sfdt-health-family-count')?.textContent).toBe('(2)');
    expect(family.querySelector('.sfdt-health-family-impact')?.textContent).toBe('Score impact: -8');
    const items = family.querySelectorAll('.sfdt-health-affected-list li');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toBe('Get_Account');
  });

  it('shows the "No specific items listed" fallback for a family with no items', () => {
    const handle = mountHealthModal();
    const report = makeReport();
    report.issueFamilies[0]!.affectedItems = [];
    handle.showReport(report);
    expect(document.querySelector('.sfdt-health-affected-list li')?.textContent).toBe(
      'No specific items listed.',
    );
  });

  it('shows the empty state when there are no issue families', () => {
    const handle = mountHealthModal();
    handle.showReport(makeReport({ issueFamilies: [] }));
    expect(document.querySelector('.sfdt-health-empty')?.textContent).toContain('excellent shape');
    expect(document.querySelector('.sfdt-health-family')).toBeNull();
  });
});

describe('health-modal — copy JSON', () => {
  it('invokes the onCopyJson callback with the raw JSON', () => {
    const onCopyJson = vi.fn();
    const handle = mountHealthModal({ onCopyJson });
    handle.showReport(makeReport());
    const copyBtn = Array.from(document.querySelectorAll<HTMLButtonElement>('.sfdt-health-btn')).find(
      (b) => b.textContent === 'Copy JSON',
    )!;
    copyBtn.click();
    expect(onCopyJson).toHaveBeenCalledWith('{"flow":"raw"}');
  });

  it('falls back to navigator.clipboard when no callback is supplied', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    const handle = mountHealthModal();
    handle.showReport(makeReport());
    document.querySelector<HTMLButtonElement>('.sfdt-health-btn')!.click();
    expect(writeText).toHaveBeenCalledWith('{"flow":"raw"}');
  });
});

describe('health-modal — rating colours', () => {
  it('exercises every rating branch without throwing', () => {
    const handle = mountHealthModal();
    for (const rating of ['Excellent', 'Very Good', 'Good', 'Poor', 'Very Poor']) {
      const report = makeReport();
      (report.summary as { rating: string }).rating = rating;
      handle.showReport(report);
      expect(document.querySelector('.sfdt-health-rating')?.textContent).toBe(rating);
    }
  });
});
