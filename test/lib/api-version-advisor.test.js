import { describe, it, expect } from 'vitest';
import {
  loadRegistry,
  sliceRegistry,
  selectComponents,
  buildAdvisorContext,
  ADVISOR_COMPONENT_CAP,
} from '../../src/lib/api-version-advisor.js';

const registry = await loadRegistry();

describe('sliceRegistry', () => {
  it('returns the (from, to] window — the versions an upgrade passes through', () => {
    const slice = sliceRegistry(registry, 58, 61);
    expect(Object.keys(slice)).toEqual(['59', '60', '61']);
    expect(slice['60'].apex.changes.join(' ')).toContain('??');
  });

  it('is empty when already at the target', () => {
    expect(sliceRegistry(registry, 67, 67)).toEqual({});
  });

  it('silently skips versions the registry lacks', () => {
    const slice = sliceRegistry(registry, 40, 46); // 41-44 not curated
    expect(Object.keys(slice)).toEqual(['45', '46']);
  });
});

describe('selectComponents', () => {
  const components = [
    { type: 'ApexClass', name: 'A', apiVersion: 50 },
    { type: 'ApexTrigger', name: 'T', apiVersion: 62 },
    { type: 'Flow', name: 'F', apiVersion: 55 },
    { type: 'LWC', name: 'L', apiVersion: 48 },
    { type: 'Aura', name: 'Au', apiVersion: 45 },
    { type: 'ApexClass', name: 'Fresh', apiVersion: 67 },
    { type: 'Flow', name: 'NoVer', apiVersion: null }, // unspecified — never advised
  ];

  it('keeps only versioned components below the target', () => {
    expect(selectComponents(components, 67).map((c) => c.name)).toEqual(['A', 'T', 'F', 'L', 'Au']);
  });

  it('filters by family — apex covers classes and triggers, lwc covers Aura too', () => {
    expect(selectComponents(components, 67, 'apex').map((c) => c.name)).toEqual(['A', 'T']);
    expect(selectComponents(components, 67, 'flow').map((c) => c.name)).toEqual(['F']);
    expect(selectComponents(components, 67, 'lwc').map((c) => c.name)).toEqual(['L', 'Au']);
  });
});

describe('buildAdvisorContext', () => {
  it('slices from the oldest component to the target and serializes the variables', () => {
    const ctx = buildAdvisorContext({
      components: [{ type: 'ApexClass', name: 'A', apiVersion: 59 }],
      registry,
      targetVersion: 61,
      sourceApiVersion: '66.0',
    });
    expect(ctx.targetVersion).toBe('61');
    expect(ctx.sourceApiVersion).toBe('66.0');
    const slice = JSON.parse(ctx.registrySlice);
    expect(Object.keys(slice)).toEqual(['60', '61']);
    expect(JSON.parse(ctx.componentsJson)).toEqual([{ type: 'ApexClass', name: 'A', apiVersion: 59 }]);
  });

  it('caps the component list and states the truncation in the payload', () => {
    const many = Array.from({ length: ADVISOR_COMPONENT_CAP + 25 }, (_, i) => ({
      type: 'ApexClass',
      name: `C${i}`,
      apiVersion: 50,
    }));
    const ctx = buildAdvisorContext({ components: many, registry, targetVersion: 67, sourceApiVersion: null });
    expect(ctx.componentsJson).toContain('25 additional component(s) omitted');
    expect(ctx.sourceApiVersion).toBe('not set');
    // the JSON part still parses (the note is an appended comment line)
    const jsonPart = ctx.componentsJson.slice(0, ctx.componentsJson.lastIndexOf('\n//'));
    expect(JSON.parse(jsonPart)).toHaveLength(ADVISOR_COMPONENT_CAP);
  });
});
