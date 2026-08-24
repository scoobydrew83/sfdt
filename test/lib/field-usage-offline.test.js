import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { runOfflineFieldUsage } from '../../src/lib/field-usage-offline.js';

// Driven against a REAL temporary source tree rather than mocks. The thing most
// likely to break here is path handling and file enumeration, and a mocked fs
// would assert my assumptions about globbing rather than test them.

let root;

const write = async (rel, body) => {
  const file = path.join(root, rel);
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, body, 'utf8');
};

const field = (name, type = 'Text') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">\n  <fullName>${name}</fullName>\n  <label>${name.replace(/__c$/, '')}</label>\n  <type>${type}</type>\n</CustomField>\n`;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfdt-offline-'));
  const base = 'force-app/main/default';

  await write(`${base}/objects/Account/fields/Region__c.field-meta.xml`, field('Region__c', 'Picklist'));
  await write(`${base}/objects/Account/fields/Sub_Region__c.field-meta.xml`, field('Sub_Region__c'));
  await write(`${base}/objects/Account/fields/Legacy__c.field-meta.xml`, field('Legacy__c'));
  await write(`${base}/objects/Account/fields/Derived__c.field-meta.xml`,
    field('Derived__c', 'Formula').replace('</CustomField>', '  <formula>Region__c &amp; "x"</formula>\n</CustomField>'));

  // Logical use of Sub_Region__c only. If substring matching leaked, Region__c
  // would be marked used by this file too.
  await write(`${base}/classes/AccountService.cls`,
    'public class AccountService { void go(Account a) { a.Sub_Region__c = \'x\'; } }');

  // Structural-only references for Legacy__c.
  await write(`${base}/profiles/Admin.profile-meta.xml`,
    '<Profile><fieldPermissions><field>Account.Legacy__c</field></fieldPermissions></Profile>');
  await write(`${base}/layouts/Account-Account Layout.layout-meta.xml`,
    '<Layout><layoutSections><layoutColumns><layoutItems><field>Legacy__c</field></layoutItems></layoutColumns></layoutSections></Layout>');

  // Must never be scanned.
  await write(`${base}/objects/Account/Account.object-meta.xml`,
    '<CustomObject><fields><fullName>Legacy__c</fullName></fields></CustomObject>');
  await write('node_modules/junk/index.js', 'const Legacy__c = 1;');
});

afterAll(async () => {
  await fs.remove(root);
});

const config = () => ({ _projectRoot: root, defaultSourcePath: 'force-app/main/default' });

describe('runOfflineFieldUsage', () => {
  it('reads the field list from source, with no org', async () => {
    const vm = await runOfflineFieldUsage(config(), 'Account');
    expect(vm.rows.map((r) => r.name).sort()).toEqual([
      'Derived__c', 'Legacy__c', 'Region__c', 'Sub_Region__c',
    ]);
    expect(vm.object).toBe('Account');
  });

  it('counts another field\'s FORMULA as a real reference', async () => {
    const vm = await runOfflineFieldUsage(config(), 'Account');
    const region = vm.rows.find((r) => r.name === 'Region__c');

    expect(region.unreferenced).toBe(false);
    expect(region.references.some((g) => g.type === 'CustomField')).toBe(true);
  });

  it('does not let a field reference itself through its own definition file', async () => {
    // Every `.field-meta.xml` names its own field in `<fullName>`. Without the
    // self-match guard nothing would ever be a candidate.
    const vm = await runOfflineFieldUsage(config(), 'Account');
    const derived = vm.rows.find((r) => r.name === 'Derived__c');

    expect(derived.unreferenced).toBe(true);
  });

  it('does not match a short field name inside a longer one', async () => {
    // AccountService.cls mentions Sub_Region__c only.
    const vm = await runOfflineFieldUsage(config(), 'Account');
    const sub = vm.rows.find((r) => r.name === 'Sub_Region__c');
    const region = vm.rows.find((r) => r.name === 'Region__c');

    expect(sub.references.some((g) => g.type === 'ApexClass')).toBe(true);
    expect(region.references.some((g) => g.type === 'ApexClass')).toBe(false);
  });

  it('reports a profile-and-layout-only field as unreferenced, but shows both', async () => {
    const vm = await runOfflineFieldUsage(config(), 'Account');
    const legacy = vm.rows.find((r) => r.name === 'Legacy__c');

    expect(legacy.unreferenced).toBe(true);
    expect(legacy.references.map((g) => g.type).sort()).toEqual([
      'Layout (structural)', 'Profile (structural)',
    ]);
  });

  it('never scans the object file or node_modules', async () => {
    // Both mention Legacy__c; either would wrongly mark it used.
    const vm = await runOfflineFieldUsage(config(), 'Account');
    const legacy = vm.rows.find((r) => r.name === 'Legacy__c');

    expect(legacy.references.some((g) => g.type.startsWith('CustomObject'))).toBe(false);
    expect(legacy.unreferenced).toBe(true);
  });

  it('says so plainly when the object is not tracked in source', async () => {
    const vm = await runOfflineFieldUsage(config(), 'Contact');

    expect(vm.rows).toEqual([]);
    expect(vm.notes.some((n) => n.includes('No field metadata found'))).toBe(true);
    // A fact about the repo, not a finding about any field.
    expect(vm.counts.unreferenced).toBe(0);
  });

  it('reports no field as safe to remove, whatever it found', async () => {
    const vm = await runOfflineFieldUsage(config(), 'Account');
    expect(vm.rows.every((r) => r.safeToRemove === null)).toBe(true);
  });
});
