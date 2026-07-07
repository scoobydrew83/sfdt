import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock flow-core's runFlowQuality so this feature test asserts the wiring + render,
// not flow-core's scoring (that's covered in flow-core's own tests).
vi.mock('@sfdt/flow-core', async (importActual) => ({
  ...(await importActual()),
  runFlowQuality: vi.fn(() => ({
    summary: { overallScore: 88, rating: 'Good', severityCounts: { high: 1 }, categoryCounts: {} },
    issueFamilies: [
      {
        scoreFamily: 'faultPaths',
        title: 'Missing fault paths',
        severity: 'high',
        category: 'reliability',
        scoreImpact: 12,
        instanceCount: 1,
        affectedItems: [{ type: 'element', label: 'Create Account', apiName: 'Create_Account' }],
        findings: [{ recommendation: 'Add a fault connector.' }],
      },
    ],
    findings: [],
    dependencies: [{ type: 'ApexAction', name: 'MyController', count: 1 }],
    meta: {},
  })),
}));

import { runFlowQuality } from '@sfdt/flow-core';
import { createFlowQualityFeature } from '../features/flow-quality.js';
import { setWorkspaceViewSink } from '../ui/present-view.js';
import type { SalesforceApiClient } from '../lib/salesforce-api.js';

const flush = () => new Promise((r) => setTimeout(r, 0));
const scanBtn = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Scan')!;

beforeEach(() => {
  document.body.innerHTML = '';
  setWorkspaceViewSink(null);
  window.history.replaceState({}, '', 'https://x.lightning.force.com/lightning/setup/SetupOneHome/home');
});

describe('flow-quality feature (Direct)', () => {
  it('fetches metadata via the API and scores it in-browser — no bridge', async () => {
    const getFlowMetadata = vi.fn(async () => ({ Metadata: { label: 'My Flow' } }));
    const api = { getFlowMetadata } as unknown as SalesforceApiClient;
    const feature = createFlowQualityFeature({ api });
    await feature.onActivate?.();
    (document.querySelector('input[type="text"]') as HTMLInputElement).value = 'My_Flow';
    scanBtn().click();

    await vi.waitFor(() => expect(document.body.textContent).toContain('88'));
    expect(getFlowMetadata).toHaveBeenCalledWith('My_Flow');
    expect(vi.mocked(runFlowQuality)).toHaveBeenCalledWith({ label: 'My Flow' }, { flowApiName: 'My_Flow' });
    expect(document.body.textContent).toContain('Good');
    expect(document.body.textContent).toContain('high: 1');
    // Full report: issue family, affected element, recommendation, and dependency.
    expect(document.body.textContent).toContain('Missing fault paths');
    expect(document.body.textContent).toContain('Create Account');
    expect(document.body.textContent).toContain('Add a fault connector.');
    expect(document.body.textContent).toContain('MyController');
  });

  it('requires a Flow name and never calls the API when empty', async () => {
    const getFlowMetadata = vi.fn();
    const feature = createFlowQualityFeature({ api: { getFlowMetadata } as unknown as SalesforceApiClient });
    await feature.onActivate?.();
    scanBtn().click();
    await flush();
    expect(document.body.textContent).toContain('Enter a Flow API name');
    expect(getFlowMetadata).not.toHaveBeenCalled();
  });

  it('surfaces a fetch error', async () => {
    const api = {
      getFlowMetadata: vi.fn(async () => { throw new Error('Flow not found'); }),
    } as unknown as SalesforceApiClient;
    const feature = createFlowQualityFeature({ api });
    await feature.onActivate?.();
    (document.querySelector('input[type="text"]') as HTMLInputElement).value = 'Nope';
    scanBtn().click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('Flow not found'));
  });
});
