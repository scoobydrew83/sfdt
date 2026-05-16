import { describe, it, expect } from 'vitest';
import {
  lightningHostname,
  mySalesforceHostname,
  setupHostname,
} from '../lib/hostname.js';
describe('extension/lib/hostname', () => {
  describe('setupHostname', () => {
    it('passes through an existing salesforce-setup.com host unchanged', () => {
      expect(setupHostname('myco.my.salesforce-setup.com')).toBe('myco.my.salesforce-setup.com');
    });
    it('builds the setup host from a lightning.force.com source', () => {
      expect(setupHostname('myco.lightning.force.com')).toBe('myco.my.salesforce-setup.com');
    });
    it('builds the setup host from a my.salesforce.com source', () => {
      expect(setupHostname('myco.my.salesforce.com')).toBe('myco.my.salesforce-setup.com');
    });
    it('uses only the first hostname segment (CHANGELOG-v2.0.0.md:60-95 v1.2.2 fix)', () => {
      expect(setupHostname('learningtoflow-dev-ed.lightning.force.com')).toBe(
        'learningtoflow-dev-ed.my.salesforce-setup.com',
      );
    });
  });
  describe('lightningHostname', () => {
    it('passes through an existing lightning.force.com host', () => {
      expect(lightningHostname('myco.lightning.force.com')).toBe('myco.lightning.force.com');
    });
    it('builds the lightning host from a my.salesforce.com source', () => {
      expect(lightningHostname('myco.my.salesforce.com')).toBe('myco.lightning.force.com');
    });
    it('preserves the sandbox middle segment when reconstructing', () => {
      expect(lightningHostname('myco.sandbox.my.salesforce.com')).toBe(
        'myco.sandbox.lightning.force.com',
      );
    });
    it('preserves the develop / scratch / trailblaze middle segments', () => {
      expect(lightningHostname('myco.develop.my.salesforce.com')).toBe(
        'myco.develop.lightning.force.com',
      );
      expect(lightningHostname('myco.scratch.my.salesforce.com')).toBe(
        'myco.scratch.lightning.force.com',
      );
      expect(lightningHostname('myco.trailblaze.my.salesforce.com')).toBe(
        'myco.trailblaze.lightning.force.com',
      );
    });
    it('handles the dev-ed regression case from CHANGELOG-v2.0.0.md:88-90', () => {
      expect(lightningHostname('learningtoflow-dev-ed.my.salesforce-setup.com')).toBe(
        'learningtoflow-dev-ed.lightning.force.com',
      );
    });
  });
  describe('mySalesforceHostname', () => {
    it('passes through an existing my.salesforce.com host', () => {
      expect(mySalesforceHostname('myco.my.salesforce.com')).toBe('myco.my.salesforce.com');
    });
    it('builds from a lightning.force.com source', () => {
      expect(mySalesforceHostname('myco.lightning.force.com')).toBe('myco.my.salesforce.com');
    });
    it('builds from a salesforce-setup.com source', () => {
      expect(mySalesforceHostname('myco.my.salesforce-setup.com')).toBe('myco.my.salesforce.com');
    });
    it('returns null for an unrecognised host', () => {
      expect(mySalesforceHostname('example.com')).toBeNull();
    });
    it('preserves the develop/sandbox/scratch/trailblaze middle segment', () => {
      expect(mySalesforceHostname('myorg.develop.lightning.force.com')).toBe(
        'myorg.develop.my.salesforce.com',
      );
      expect(mySalesforceHostname('myorg.sandbox.lightning.force.com')).toBe(
        'myorg.sandbox.my.salesforce.com',
      );
      expect(mySalesforceHostname('myorg.scratch.lightning.force.com')).toBe(
        'myorg.scratch.my.salesforce.com',
      );
      expect(mySalesforceHostname('myorg.trailblaze.my.salesforce-setup.com')).toBe(
        'myorg.trailblaze.my.salesforce.com',
      );
    });
  });
});
