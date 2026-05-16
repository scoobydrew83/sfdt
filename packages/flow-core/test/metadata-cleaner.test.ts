import { describe, it, expect } from 'vitest';
import {
  cleanFlowMetadata,
  estimateTokens,
  summariseFlowMetadata,
} from '../src/metadata-cleaner.js';
describe('flow-core/metadata-cleaner', () => {
  describe('cleanFlowMetadata', () => {
    it('returns undefined for empty input', () => {
      expect(cleanFlowMetadata(null)).toBeUndefined();
      expect(cleanFlowMetadata(undefined)).toBeUndefined();
      expect(cleanFlowMetadata({})).toBeUndefined();
    });
    it('strips top-level processMetadataValues unconditionally', () => {
      const out = cleanFlowMetadata({
        label: 'X',
        processMetadataValues: [{ name: 'BuilderType', value: { stringValue: 'LightningFlowBuilder' } }],
      });
      expect(out).toEqual({ label: 'X' });
    });
    it('strips locationX / locationY anywhere in the tree', () => {
      const out = cleanFlowMetadata({
        label: 'X',
        assignments: [{ name: 'A', locationX: 100, locationY: 50, label: 'Set' }],
      });
      expect(out).toEqual({ label: 'X', assignments: [{ name: 'A', label: 'Set' }] });
    });
    it('removes empty arrays and empty objects', () => {
      const out = cleanFlowMetadata({
        label: 'X',
        loops: [],
        decisions: [{ name: 'D', rules: [] }],
      });
      expect(out).toEqual({ label: 'X', decisions: [{ name: 'D' }] });
    });
    it('preserves non-empty nested arrays + objects', () => {
      const out = cleanFlowMetadata({
        label: 'X',
        assignments: [{ name: 'A', assignmentItems: [{ field: 'Owner' }] }],
      });
      expect(out).toEqual({ label: 'X', assignments: [{ name: 'A', assignmentItems: [{ field: 'Owner' }] }] });
    });
  });
  describe('summariseFlowMetadata', () => {
    it('counts elements and resources by category', () => {
      const summary = summariseFlowMetadata({
        label: 'Demo',
        processType: 'Flow',
        status: 'Active',
        apiVersion: 62,
        decisions: [{ name: 'D1' }, { name: 'D2' }],
        recordLookups: [{ name: 'G' }],
        variables: [{ name: 'v1' }, { name: 'v2' }],
      })!;
      expect(summary.totalElements).toBe(3);
      expect(summary.totalResources).toBe(2);
      expect(summary.elements).toEqual({ Decisions: 2, 'Get Records': 1 });
      expect(summary.resources).toEqual({ Variables: 2 });
    });
    it('returns null for null/undefined input', () => {
      expect(summariseFlowMetadata(null)).toBeNull();
      expect(summariseFlowMetadata(undefined)).toBeNull();
    });
  });
  describe('estimateTokens', () => {
    it('uses the 4-chars-per-token heuristic', () => {
      expect(estimateTokens('a'.repeat(40))).toBe(10);
      expect(estimateTokens('a')).toBe(1);
      expect(estimateTokens('')).toBe(0);
      expect(estimateTokens(null)).toBe(0);
    });
  });
});
