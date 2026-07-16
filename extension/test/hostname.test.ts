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

    it('rebuilds from the first hostname segment only', () => {
      // Newer dev-edition orgs lack a `.my.` middle segment in their
      // Lightning hostname; concatenating it in produces a non-existent DNS name.
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

    it('builds the lightning host for a dev-edition setup source', () => {
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

    // P0-5 host coverage — gov-cloud (.mil), China (.sfcrmapps.cn), and
    // Defender (.mcas.ms) proxies. Each resolves to the correct instance host
    // OR fails cleanly (null → the proxy falls back to the page origin).
    describe('gov-cloud (.mil)', () => {
      it('passes through an existing my.salesforce.mil host', () => {
        expect(mySalesforceHostname('gov.my.salesforce.mil')).toBe('gov.my.salesforce.mil');
      });
      it('builds from a lightning.force.mil source', () => {
        expect(mySalesforceHostname('gov.lightning.force.mil')).toBe('gov.my.salesforce.mil');
      });
      it('builds from a salesforce-setup.mil source', () => {
        expect(mySalesforceHostname('gov.my.salesforce-setup.mil')).toBe('gov.my.salesforce.mil');
      });
      it('preserves the sandbox middle segment', () => {
        expect(mySalesforceHostname('gov.sandbox.lightning.force.mil')).toBe(
          'gov.sandbox.my.salesforce.mil',
        );
      });
      it('rebuilds Lightning + Setup hosts symmetrically', () => {
        expect(lightningHostname('gov.my.salesforce.mil')).toBe('gov.lightning.force.mil');
        expect(setupHostname('gov.lightning.force.mil')).toBe('gov.my.salesforce-setup.mil');
      });
    });

    describe('China (.sfcrmapps.cn)', () => {
      it('passes through an existing my.sfcrmapps.cn host', () => {
        expect(mySalesforceHostname('cn.my.sfcrmapps.cn')).toBe('cn.my.sfcrmapps.cn');
      });
      it('builds from a lightning.sfcrmapps.cn source', () => {
        expect(mySalesforceHostname('cn.lightning.sfcrmapps.cn')).toBe('cn.my.sfcrmapps.cn');
      });
      it('rebuilds the Lightning host symmetrically', () => {
        expect(lightningHostname('cn.my.sfcrmapps.cn')).toBe('cn.lightning.sfcrmapps.cn');
      });
    });

    describe('Defender .mcas.ms proxy', () => {
      it('returns null (no canonical API host — the proxy origin is used)', () => {
        // The sid cookie lives on the proxy origin and the API must go back
        // through the proxy, so there is no my.* host to fabricate.
        expect(mySalesforceHostname('acme-my-salesforce-com.us.mcas.ms')).toBeNull();
      });
    });

    it('preserves the develop/sandbox/scratch/trailblaze middle segment', () => {
      // Live regression: a real dev-edition org reported
      // INVALID_SESSION_ID 401s on Flow Health Check because the API host
      // was being built without the `.develop.` middle segment.
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
