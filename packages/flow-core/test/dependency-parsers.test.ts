import { describe, it, expect } from 'vitest';
import {
  extractApexRefs, extractLwcApexRefs, extractFormulaRefs, extractFlowRefs,
} from '../src/dependency-parsers.js';

describe('extractApexRefs', () => {
  it('captures Type.forName class literal', () => {
    const r = extractApexRefs("Object o = Type.forName('BillingHandler').newInstance();");
    expect(r).toEqual([{ toName: 'BillingHandler', toType: 'ApexClass', kind: 'apex-dynamic', evidence: "Type.forName('BillingHandler')", line: 1 }]);
  });
  it('uses the second arg when a namespace is given', () => {
    const r = extractApexRefs("Type.forName('ns','RiskSvc')");
    expect(r[0].toName).toBe('RiskSvc');
  });
  it('does NOT capture a dynamic (non-literal) forName arg', () => {
    expect(extractApexRefs('Type.forName(className)')).toEqual([]);
  });
  it('extracts FROM objects from Database.query literals', () => {
    const r = extractApexRefs("Database.query('SELECT Id FROM Account__c WHERE X = 1');");
    expect(r.map((x) => x.toName)).toContain('Account__c');
    expect(r[0].kind).toBe('apex-dynamic');
  });
  it('flags Schema.getGlobalDescribe as broad dynamic access', () => {
    const r = extractApexRefs('Map<String,Schema.SObjectType> m = Schema.getGlobalDescribe();');
    expect(r[0]).toMatchObject({ toName: '(all objects)', toType: 'CustomObject', kind: 'apex-dynamic' });
  });
  it('reports the correct 1-based line', () => {
    const r = extractApexRefs("line1\nline2\nType.forName('Foo')");
    expect(r[0].line).toBe(3);
  });
});

describe('extractLwcApexRefs', () => {
  it('captures the Apex class from an @salesforce/apex import', () => {
    const r = extractLwcApexRefs("import getAll from '@salesforce/apex/AccountSvc.getAll';");
    expect(r[0]).toMatchObject({ toName: 'AccountSvc', toType: 'ApexClass', kind: 'lwc-apex' });
  });
});

describe('extractFormulaRefs', () => {
  it('extracts custom field/relationship tokens, filtering formula keywords', () => {
    const xml = '<CustomField><formula>IF(ISBLANK(Region__c), Account.Name, Territory__r.Code__c)</formula></CustomField>';
    const names = extractFormulaRefs(xml).map((r) => r.toName);
    expect(names).toContain('Region__c');
    expect(names).toContain('Territory__r');
    expect(names).not.toContain('IF');
    expect(names).not.toContain('ISBLANK');
  });
  it('does not treat CASE() as a Case object collision', () => {
    const xml = '<CustomField><formula>CASE(Status, "Open", "O", Case.CaseNumber)</formula></CustomField>';
    const names = extractFormulaRefs(xml).map((r) => r.toName);
    expect(names).toContain('Case');
  });
  it('returns [] when there is no formula element', () => {
    expect(extractFormulaRefs('<CustomField><type>Text</type></CustomField>')).toEqual([]);
  });
});

describe('extractFlowRefs', () => {
  it('captures subflow, apex action, and record object references', () => {
    const xml = `
      <Flow>
        <subflows><name>s1</name><flowName>Child_Flow</flowName></subflows>
        <actionCalls><name>a1</name><actionName>AccountSvc</actionName><actionType>apex</actionType></actionCalls>
        <recordLookups><name>q1</name><object>Contact</object></recordLookups>
      </Flow>`;
    const r = extractFlowRefs(xml);
    expect(r).toContainEqual(expect.objectContaining({ toName: 'Child_Flow', toType: 'Flow', kind: 'flow-subflow' }));
    expect(r).toContainEqual(expect.objectContaining({ toName: 'AccountSvc', toType: 'ApexClass', kind: 'flow-action' }));
    expect(r).toContainEqual(expect.objectContaining({ toName: 'Contact', toType: 'CustomObject', kind: 'flow-field' }));
  });
});
