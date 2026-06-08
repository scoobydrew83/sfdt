import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock execa and flow quality
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../../src/lib/flow-quality.js', () => ({
  runFlowQuality: vi.fn().mockReturnValue({
    meta: { flowType: 'AutoLaunched', apiVersion: '62.0', status: 'Active' },
    summary: { overallScore: 95, rating: 'Excellent', severityCounts: {}, categoryCounts: {} },
    issueFamilies: [],
  }),
}));

import { execa } from 'execa';
import {
  listFlowDefinitions,
  fetchActiveVersion,
  runFlowScan,
  runFlowConflicts,
  runFlowGraph,
} from '../../src/lib/flow-analyzer.js';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('Flow Analyzer', () => {
  const org = 'dev-org';

  describe('listFlowDefinitions', () => {
    it('executes the tooling query for active flow definitions', async () => {
      execa.mockResolvedValue({
        stdout: JSON.stringify({
          result: {
            records: [
              { Id: 'def-1', DeveloperName: 'Flow_A', ActiveVersionId: 'ver-1' },
            ],
          },
        }),
      });

      const records = await listFlowDefinitions(org);

      expect(execa).toHaveBeenCalledWith(
        'sf',
        expect.arrayContaining(['data', 'query', '--use-tooling-api', '-q']),
        expect.anything(),
      );
      expect(records).toHaveLength(1);
      expect(records[0].DeveloperName).toBe('Flow_A');
    });

    it('throws error on invalid org alias to prevent shell injection', async () => {
      await expect(listFlowDefinitions('; evil-command')).rejects.toThrow('Invalid org alias');
    });
  });

  describe('fetchActiveVersion', () => {
    it('queries details for the specific flow version id', async () => {
      execa.mockResolvedValue({
        stdout: JSON.stringify({
          result: {
            records: [
              { Id: 'ver-1', MasterLabel: 'Flow A', Metadata: { label: 'Flow A' } },
            ],
          },
        }),
      });

      const record = await fetchActiveVersion(org, 'ver-1');

      expect(record.Id).toBe('ver-1');
      expect(record.MasterLabel).toBe('Flow A');
    });
  });

  describe('runFlowScan', () => {
    it('fetches active versions in parallel and compiles reports', async () => {
      // 1. Mock listFlowDefinitions response
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{ Id: 'def-1', DeveloperName: 'Flow_A', ActiveVersionId: 'ver-1' }],
          },
        }),
      });

      // 2. Mock fetchActiveVersion response
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{ Id: 'ver-1', MasterLabel: 'Flow A', Metadata: { label: 'Flow A' } }],
          },
        }),
      });

      const scan = await runFlowScan(org, '62.0');

      expect(scan.totalFlows).toBe(1);
      expect(scan.reports[0].developerName).toBe('Flow_A');
      expect(scan.reports[0].overallScore).toBe(95);
    });

    it('handles query or fetch errors by adding them to errors list', async () => {
      // 1. Mock listFlowDefinitions response
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{ Id: 'def-1', DeveloperName: 'Flow_Bad', ActiveVersionId: 'ver-bad' }],
          },
        }),
      });

      // 2. Mock fetchActiveVersion response to throw error
      execa.mockRejectedValueOnce(new Error('Tooling API query failed'));

      const scan = await runFlowScan(org, '62.0');

      expect(scan.totalFlows).toBe(0);
      expect(scan.totalErrors).toBe(1);
      expect(scan.errors[0].developerName).toBe('Flow_Bad');
      expect(scan.errors[0].message).toContain('Tooling API query failed');
    });
  });

  describe('runFlowConflicts', () => {
    it('calculates trigger overlaps correctly', async () => {
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [
              { Id: 'def-1', DeveloperName: 'Flow_A', ActiveVersionId: 'ver-1' },
              { Id: 'def-2', DeveloperName: 'Flow_B', ActiveVersionId: 'ver-2' },
            ],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-1',
              MasterLabel: 'Flow A',
              Metadata: {
                start: {
                  object: 'Account',
                  triggerType: 'RecordAfterSave',
                  recordTriggerType: 'CreateAndUpdate',
                },
              },
            }],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-2',
              MasterLabel: 'Flow B',
              Metadata: {
                start: {
                  object: 'Account',
                  triggerType: 'RecordAfterSave',
                  recordTriggerType: 'Create',
                },
              },
            }],
          },
        }),
      });

      const result = await runFlowConflicts(org);

      expect(result.totalGroups).toBe(1);
      expect(result.groups[0].objectApiName).toBe('Account');
      expect(result.groups[0].flows).toHaveLength(2);
    });
  });

  describe('runFlowGraph', () => {
    it('constructs a call graph and outputs Mermaid flowchart notation', async () => {
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [
              { Id: 'def-1', DeveloperName: 'Flow_Parent', ActiveVersionId: 'ver-1' },
              { Id: 'def-2', DeveloperName: 'Flow_Child', ActiveVersionId: 'ver-2' },
            ],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-1',
              MasterLabel: 'Parent Flow',
              Metadata: {
                subflows: [{ flowName: 'Flow_Child' }],
              },
            }],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-2',
              MasterLabel: 'Child Flow',
              Metadata: { subflows: [] },
            }],
          },
        }),
      });

      const graph = await runFlowGraph(org);

      expect(graph.nodes['Flow_Parent']).toBeDefined();
      expect(graph.nodes['Flow_Child']).toBeDefined();
      expect(graph.mermaid).toContain('flowchart TD');
      expect(graph.mermaid).toContain('Flow_Parent --> Flow_Child');
    });

    it('detects circular dependencies and appends red styling to Mermaid flowchart', async () => {
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [
              { Id: 'def-1', DeveloperName: 'Flow_A', ActiveVersionId: 'ver-1' },
              { Id: 'def-2', DeveloperName: 'Flow_B', ActiveVersionId: 'ver-2' },
            ],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-1',
              MasterLabel: 'Flow A',
              Metadata: { subflows: [{ flowName: 'Flow_B' }] },
            }],
          },
        }),
      });

      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{
              Id: 'ver-2',
              MasterLabel: 'Flow B',
              Metadata: { subflows: [{ flowName: 'Flow_A' }] },
            }],
          },
        }),
      });

      const graph = await runFlowGraph(org);

      expect(graph.cycles).toContainEqual(expect.arrayContaining(['Flow_A', 'Flow_B']));
      expect(graph.mermaid).toContain('style Flow_A stroke:#ff0000');
      expect(graph.mermaid).toContain('style Flow_B stroke:#ff0000');
    });

    it('captures fetch errors in graph compilation without crashing', async () => {
      execa.mockResolvedValueOnce({
        stdout: JSON.stringify({
          result: {
            records: [{ Id: 'def-1', DeveloperName: 'Flow_Bad', ActiveVersionId: 'ver-bad' }],
          },
        }),
      });

      execa.mockRejectedValueOnce(new Error('Fetch metadata error'));

      const graph = await runFlowGraph(org);

      expect(Object.keys(graph.nodes)).toHaveLength(0);
      expect(graph.errors).toHaveLength(1);
      expect(graph.errors[0].developerName).toBe('Flow_Bad');
      expect(graph.errors[0].message).toContain('Fetch metadata error');
    });
  });
});
