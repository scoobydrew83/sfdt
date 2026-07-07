import { describe, it, expect } from 'vitest';
import { isApexTestClass, classNameFromFile } from '../src/lib/apex-test-detect.js';

describe('isApexTestClass', () => {
  it('detects @isTest annotations (any case/spacing)', () => {
    expect(isApexTestClass('@isTest\npublic class FooTest {}')).toBe(true);
    expect(isApexTestClass('@IsTest private class X {}')).toBe(true);
    expect(isApexTestClass('@ isTest\nclass X {}')).toBe(true);
  });

  it('detects the legacy testMethod keyword', () => {
    expect(isApexTestClass('public class X { static testMethod void t() {} }')).toBe(true);
  });

  it('ignores annotations inside comments', () => {
    expect(isApexTestClass('// @isTest\npublic class NotATest {}')).toBe(false);
    expect(isApexTestClass('/* @isTest */\npublic class NotATest {}')).toBe(false);
  });

  it('returns false for non-test classes and empty input', () => {
    expect(isApexTestClass('public class Service { void doWork() {} }')).toBe(false);
    expect(isApexTestClass('')).toBe(false);
  });
});

describe('classNameFromFile', () => {
  it('derives the class name from a .cls path', () => {
    expect(classNameFromFile('force-app/main/default/classes/AccountServiceTest.cls')).toBe('AccountServiceTest');
    expect(classNameFromFile('C:\\proj\\FooTest.cls')).toBe('FooTest');
  });
  it('returns null for non-class files', () => {
    expect(classNameFromFile('Foo.trigger')).toBeNull();
    expect(classNameFromFile('.cls')).toBeNull();
    expect(classNameFromFile('')).toBeNull();
  });
});
