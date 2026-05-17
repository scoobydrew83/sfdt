import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  _flowHealthCheckTestApi,
  createFlowHealthCheckFeature,
} from '../features/flow-health-check.js';
import { SalesforceApiClient, type MessageBus } from '../lib/salesforce-api.js';
import type { HealthModalHandle, HealthReport } from '../ui/health-modal.js';

const { resolveFlowApiName, buildReport } = _flowHealthCheckTestApi();

function fakeWin(href: string): Window {
  const u = new URL(href);
  return {
    location: { href, hostname: u.hostname, origin: u.origin, search: u.search },
  } as unknown as Window;
}

function spyModal() {
  const calls: Array<{ kind: string; payload: unknown }> = [];
  const modal: HealthModalHandle = {
    showLoading: (label) => calls.push({ kind: 'loading', payload: label }),
    showError: (msg) => calls.push({ kind: 'error', payload: msg }),
    showReport: (report) => calls.push({ kind: 'report', payload: report }),
    close: () => calls.push({ kind: 'close', payload: null }),
    isOpen: () => true,
  };
  return { modal, calls };
}

function busThatReturnsSid(): MessageBus {
  return {
    sendMessage: (async () => ({
      ok: true,
      sids: { 'https://x.my.salesforce.com': 'sid' },
    })) as unknown as MessageBus['sendMessage'],
  };
}

function fetchResponderFor(records: unknown[]): typeof fetch {
  return (async () =>
    ({
      ok: true,
      status: 200,
      async json() {
        return { records, size: records.length, done: true };
      },
      async text() {
        return JSON.stringify({ records });
      },
    }) as Response) as typeof fetch;
}

beforeEach(() => {
  document.body.replaceChildren();
});

describe('extension/features/flow-health-check', () => {
  describe('resolveFlowApiName', () => {
    it('prefers DeveloperName over FullName', () => {
      expect(
        resolveFlowApiName(
          { DeveloperName: 'My_Flow', FullName: 'My_Flow-3' } as never,
          { label: 'My Flow' },
        ),
      ).toBe('My_Flow');
    });

    it('falls back to metadata.fullName then label', () => {
      expect(resolveFlowApiName({} as never, { fullName: 'Some_Flow', label: 'Some Flow' })).toBe(
        'Some_Flow',
      );
      expect(resolveFlowApiName({} as never, { label: 'Just A Label' })).toBe('Just A Label');
    });

    it('returns "unknown_flow" when nothing else matches', () => {
      expect(resolveFlowApiName({} as never, {})).toBe('unknown_flow');
    });
  });

  describe('buildReport', () => {
    it('produces a report with metrics, issue families, and raw JSON', () => {
      // Use a minimal in-memory normalized flow shape.
      const normalized = {
        meta: {
          flowVersionId: null,
          flowLabel: 'Tiny Flow',
          flowApiName: 'Tiny',
          flowType: 'Autolaunched' as const,
          apiVersion: 60,
          status: 'Active',
        },
        trigger: {
          objectApiName: null,
          timing: 'Unknown' as const,
          event: 'Unknown' as const,
          entryCriteriaSummary: null,
          runContext: 'Unknown',
        },
        nodes: [
          { id: '__start__', type: 'Start', label: 'Start', apiName: '__start__', description: null, supportsFaultPath: false, hasFaultPath: false, isInLoop: false, loopDepth: 0, metadata: {} },
          { id: 'D', type: 'Decision', label: 'D', apiName: 'D', description: 'documented', supportsFaultPath: false, hasFaultPath: false, isInLoop: false, loopDepth: 0, metadata: {} },
        ] as never,
        edges: [],
        resources: [],
        dependencies: [],
        metadata: {},
      };
      const issueFamilies = [
        {
          scoreFamily: 'flow_description',
          title: 'Flow description missing',
          severity: 'low' as const,
          category: 'maintainability' as const,
          scoreImpact: 1,
          instanceCount: 1,
          findings: [],
          affectedItems: [],
        },
      ];
      const report = buildReport(
        { Id: '301abc', MasterLabel: 'Tiny Flow' } as never,
        normalized as never,
        issueFamilies as never,
      );
      expect(report.summary.overallScore).toBe(99);
      expect(report.summary.metrics.decisionCount).toBe(1);
      expect(report.summary.metrics.elementCount).toBe(1);
      expect(JSON.parse(report.rawJson)).toMatchObject({
        meta: { flowLabel: 'Tiny Flow' },
        issueFamilies: [{ scoreFamily: 'flow_description' }],
      });
    });
  });

  describe('feature lifecycle', () => {
    function makeApi(flow: Record<string, unknown>): SalesforceApiClient {
      return new SalesforceApiClient({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
        messageBus: busThatReturnsSid(),
        fetchImpl: fetchResponderFor([flow]),
      });
    }

    it('errors with a clear message when not on Flow Builder', async () => {
      const { modal, calls } = spyModal();
      const feature = createFlowHealthCheckFeature({
        win: fakeWin('https://x.lightning.force.com/lightning/setup/Flows/home'),
        modal,
        api: makeApi({ Id: '301', MasterLabel: 'X', Metadata: {} }),
      });
      await feature.onActivate?.();
      expect(calls.map((c) => c.kind)).toEqual(['error']);
      expect(String(calls[0]!.payload)).toMatch(/Flow Builder/);
    });

    it('errors when the URL has no flowId', async () => {
      const { modal, calls } = spyModal();
      const feature = createFlowHealthCheckFeature({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app'),
        modal,
        api: makeApi({ Id: '301', MasterLabel: 'X', Metadata: {} }),
      });
      await feature.onActivate?.();
      expect(calls.map((c) => c.kind)).toEqual(['error']);
      expect(String(calls[0]!.payload)).toMatch(/Flow ID/);
    });

    it('runs the full pipeline end-to-end and renders a report', async () => {
      const flow = {
        Id: '301abc',
        MasterLabel: 'Demo Flow',
        Status: 'Active',
        Metadata: {
          label: 'Demo Flow',
          description: 'A demo flow.',
          apiVersion: 60,
          processType: 'Flow',
          start: { recordTriggerType: 'CreateAndUpdate', object: 'Account', filters: [{}] },
          assignments: [{ name: 'A', label: 'Set Owner', description: 'documented' }],
          recordUpdates: [
            {
              name: 'UpdateAcct',
              object: 'Account',
              description: 'documented',
              faultConnector: { targetReference: 'Handle' },
            },
          ],
        },
      };
      const { modal, calls } = spyModal();
      const api = new SalesforceApiClient({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
        messageBus: busThatReturnsSid(),
        fetchImpl: fetchResponderFor([flow]),
      });
      const feature = createFlowHealthCheckFeature({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
        modal,
        api,
      });
      await feature.onActivate?.();

      const reportCall = calls.find((c) => c.kind === 'report');
      expect(reportCall).toBeDefined();
      const report = reportCall!.payload as HealthReport;
      expect(report.meta.flowLabel).toBe('Demo Flow');
      expect(report.summary.overallScore).toBe(100);
      expect(report.issueFamilies).toHaveLength(0);
    });

    it('produces a low score on a flow with DML inside a loop', async () => {
      const flow = {
        Id: '301abc',
        MasterLabel: 'Bad Flow',
        Metadata: {
          label: 'Bad Flow',
          description: 'present',
          apiVersion: 60,
          processType: 'Flow',
          loops: [
            { name: 'L', nextValueConnector: { targetReference: 'UpdateInLoop' } },
          ],
          recordUpdates: [
            {
              name: 'UpdateInLoop',
              object: 'Account',
              description: 'present',
              connector: { targetReference: 'L' },
              faultConnector: { targetReference: 'Done' },
            },
          ],
        },
      };
      const { modal, calls } = spyModal();
      const feature = createFlowHealthCheckFeature({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
        modal,
        api: new SalesforceApiClient({
          win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
          messageBus: busThatReturnsSid(),
          fetchImpl: fetchResponderFor([flow]),
        }),
      });
      await feature.onActivate?.();
      const report = (calls.find((c) => c.kind === 'report')!.payload) as HealthReport;
      // High severity finding present.
      expect(report.summary.severityCounts.high).toBeGreaterThanOrEqual(1);
      expect(report.summary.overallScore).toBeLessThan(100);
    });

    it('surfaces fetch errors as modal error messages', async () => {
      const { modal, calls } = spyModal();
      const failingFetch = vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            async text() {
              return 'kaboom';
            },
            async json() {
              return {};
            },
          }) as Response,
      ) as unknown as typeof fetch;
      const feature = createFlowHealthCheckFeature({
        win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
        modal,
        api: new SalesforceApiClient({
          win: fakeWin('https://x.lightning.force.com/builder_platform_interaction/flowBuilder.app?flowId=300abc'),
          messageBus: busThatReturnsSid(),
          fetchImpl: failingFetch,
        }),
      });
      await feature.onActivate?.();
      const errCall = calls.find((c) => c.kind === 'error');
      expect(errCall).toBeDefined();
      expect(String(errCall!.payload)).toMatch(/500/);
    });
  });
});
