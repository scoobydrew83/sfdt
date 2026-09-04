// C-P5-1 AC-3: snapshot → viewmodel mapping, including the skipped-analyzer
// marker. The skipped cases are the load-bearing ones — a skipped scan reports
// zero violations exactly like a clean one, and rendering it as a pass is the
// J-1 policy failure this whole file exists to prevent.

import { describe, it, expect } from 'vitest';
import {
  toQualityViewModel,
  componentForFile,
  buildSetupUrl,
  filterGroups,
  severityBucket,
  statusPillClass,
  severityPillClass,
  summaryLine,
  type RawQualitySnapshot,
} from '../lib/quality-viewmodel.js';

const VIOLATIONS: RawQualitySnapshot['violations'] = [
  {
    file: 'force-app/main/default/classes/AccountService.cls',
    line: 42,
    rule: 'ApexCRUDViolation',
    engine: 'pmd',
    severity: 1,
    message: 'Validate CRUD permission before SOQL/DML operation.',
  },
  {
    file: 'force-app/main/default/classes/AccountService.cls',
    line: 7,
    rule: 'ApexDoc',
    engine: 'pmd',
    severity: 3,
    message: 'Missing ApexDoc comment.',
  },
  {
    file: 'force-app/main/default/lwc/accountCard/accountCard.js',
    line: 12,
    rule: 'no-unused-vars',
    engine: 'eslint',
    severity: 4,
    message: "'foo' is assigned a value but never used.",
  },
];

function snapshot(over: Partial<RawQualitySnapshot> = {}): RawQualitySnapshot {
  return {
    available: true,
    timestamp: '2026-08-28T10:00:00.000Z',
    status: 'FAIL',
    summary: { critical: 1, high: 0, medium: 1, low: 1 },
    violations: VIOLATIONS,
    unavailableMessage: null,
    ...over,
  };
}

describe('severityBucket', () => {
  it('maps the analyzer 1–5 scale onto the four buckets', () => {
    expect(severityBucket(1)).toBe('critical');
    expect(severityBucket(2)).toBe('high');
    expect(severityBucket(3)).toBe('medium');
    expect(severityBucket(4)).toBe('low');
    expect(severityBucket(5)).toBe('low');
    // Defensive: a nonsense rank still lands somewhere, never undefined.
    expect(severityBucket(0)).toBe('critical');
  });
});

describe('toQualityViewModel — a real run', () => {
  const vm = toQualityViewModel(snapshot());

  it('reports FAIL with per-severity counts derived from the violations', () => {
    expect(vm.status).toBe('FAIL');
    expect(vm.notice).toBeNull();
    expect(vm.total).toBe(3);
    expect(vm.counts).toEqual({ critical: 1, high: 0, medium: 1, low: 1 });
    expect(vm.timestamp).toBe('2026-08-28T10:00:00.000Z');
  });

  it('groups issues per file, worst-first, and keeps rule id + message + engine', () => {
    expect(vm.groups.map((g) => g.fileLabel)).toEqual(['AccountService.cls', 'accountCard.js']);
    const apex = vm.groups[0]!;
    expect(apex.worst).toBe('critical');
    // Within a file, most severe first (rank 1 before rank 3).
    expect(apex.issues.map((i) => i.rule)).toEqual(['ApexCRUDViolation', 'ApexDoc']);
    expect(apex.issues[0]!.message).toContain('Validate CRUD permission');
    expect(apex.issues[0]!.line).toBe(42);
    expect(apex.issues[0]!.engine).toBe('pmd');
  });

  it('collects the distinct engines for attribution filtering', () => {
    expect(vm.engines).toEqual(['eslint', 'pmd']);
  });

  it('resolves a Setup-linkable component per group where one exists', () => {
    expect(vm.groups[0]!.component).toEqual({
      toolingObject: 'ApexClass',
      setupNode: 'ApexClasses',
      name: 'AccountService',
    });
    expect(vm.groups[1]!.component?.name).toBe('accountCard');
  });
});

describe('toQualityViewModel — PASS', () => {
  it('reports PASS only for a run that actually happened and found nothing', () => {
    const vm = toQualityViewModel(snapshot({ status: 'PASS', violations: [], summary: null }));
    expect(vm.status).toBe('PASS');
    expect(vm.notice).toBeNull();
    expect(vm.total).toBe(0);
    expect(vm.groups).toEqual([]);
  });
});

describe('toQualityViewModel — the skipped-analyzer marker (J-1 parity)', () => {
  it('renders as SKIPPED, never as a pass, when status is SKIPPED', () => {
    const vm = toQualityViewModel(
      snapshot({
        status: 'SKIPPED',
        violations: [],
        summary: { critical: 0, high: 0, medium: 0, low: 0 },
        unavailableMessage: 'sf code-analyzer not installed',
      }),
    );
    expect(vm.status).toBe('SKIPPED');
    expect(vm.status).not.toBe('PASS');
    expect(vm.notice).toBe('sf code-analyzer not installed');
    expect(statusPillClass(vm.status)).not.toContain('sfdt-success');
  });

  it('treats a bare unavailableMessage as SKIPPED even when status says PASS', () => {
    // Belt and braces: an older or partial snapshot could carry the reason
    // without the status. The reason alone is enough — the scan did not run.
    const vm = toQualityViewModel(
      snapshot({
        status: 'PASS',
        violations: [],
        unavailableMessage: 'sf code-analyzer run failed',
      }),
    );
    expect(vm.status).toBe('SKIPPED');
    expect(vm.notice).toBe('sf code-analyzer run failed');
  });

  it('stays SKIPPED even when the payload happens to carry violations', () => {
    const vm = toQualityViewModel(snapshot({ status: 'SKIPPED', unavailableMessage: 'crashed' }));
    expect(vm.status).toBe('SKIPPED');
    // The issues are still surfaced — the verdict is what must not be a pass.
    expect(vm.total).toBe(3);
  });

  it('falls back to an explicit not-clean notice when no reason is given', () => {
    const vm = toQualityViewModel(
      snapshot({ status: 'SKIPPED', violations: [], unavailableMessage: null }),
    );
    expect(vm.status).toBe('SKIPPED');
    expect(vm.notice).toContain('not a clean result');
  });
});

describe('toQualityViewModel — no run recorded', () => {
  it('reports UNAVAILABLE and carries the bridge hint', () => {
    const vm = toQualityViewModel({ available: false, hint: 'run Quality from the dashboard' });
    expect(vm.status).toBe('UNAVAILABLE');
    expect(vm.notice).toBe('run Quality from the dashboard');
    expect(vm.total).toBe(0);
  });

  it('supplies its own hint when the bridge omitted one', () => {
    const vm = toQualityViewModel({ available: false });
    expect(vm.status).toBe('UNAVAILABLE');
    expect(vm.notice).toContain('sfdt ui');
  });

  it('tolerates a null/empty payload without throwing', () => {
    const vm = toQualityViewModel(null);
    expect(vm.status).toBe('PASS');
    expect(vm.total).toBe(0);
    expect(vm.engines).toEqual([]);
  });

  it('tolerates violations with missing fields', () => {
    const vm = toQualityViewModel({ available: true, violations: [{}] });
    expect(vm.total).toBe(1);
    expect(vm.groups[0]!.issues[0]!.severity).toBe('medium'); // default rank 3
    expect(vm.groups[0]!.issues[0]!.line).toBe(0);
    expect(vm.groups[0]!.component).toBeNull();
  });
});

describe('componentForFile', () => {
  it('maps source paths to their Setup component', () => {
    expect(componentForFile('force-app/main/default/classes/Foo.cls')).toEqual({
      toolingObject: 'ApexClass',
      setupNode: 'ApexClasses',
      name: 'Foo',
    });
    expect(componentForFile('force-app/main/default/triggers/AccountTrigger.trigger')).toEqual({
      toolingObject: 'ApexTrigger',
      setupNode: 'ApexTriggers',
      name: 'AccountTrigger',
    });
    expect(componentForFile('force-app/main/default/lwc/myCmp/myCmp.js')?.name).toBe('myCmp');
    expect(componentForFile('force-app/main/default/aura/MyCmp/MyCmp.cmp')?.name).toBe('MyCmp');
    expect(componentForFile('force-app/main/default/flows/My_Flow.flow-meta.xml')).toEqual({
      toolingObject: null,
      setupNode: 'Flows',
      name: 'My_Flow',
    });
  });

  it('accepts Windows separators', () => {
    expect(componentForFile('force-app\\main\\default\\classes\\Foo.cls')?.name).toBe('Foo');
  });

  it('returns null for paths Setup cannot open', () => {
    expect(componentForFile('force-app/main/default/objects/Account/Account.object-meta.xml')).toBeNull();
    expect(componentForFile('force-app/main/default/lwc/loose.js')).toBeNull();
    expect(componentForFile('README.md')).toBeNull();
    expect(componentForFile('')).toBeNull();
    // A .cls outside a classes/ directory is not an Apex class we can link.
    expect(componentForFile('scratch/Foo.cls')).toBeNull();
  });
});

describe('buildSetupUrl', () => {
  const component = { toolingObject: 'ApexClass' as const, setupNode: 'ApexClasses', name: 'Foo' };

  it('deep-links to the component when an Id is known', () => {
    expect(buildSetupUrl('x.lightning.force.com', component, '01p000000000001AAA')).toBe(
      'https://x.my.salesforce-setup.com/lightning/setup/ApexClasses/page?address=%2F01p000000000001AAA',
    );
  });

  it('falls back to the type list page with no Id', () => {
    expect(buildSetupUrl('x.lightning.force.com', component, null)).toBe(
      'https://x.my.salesforce-setup.com/lightning/setup/ApexClasses/home',
    );
  });
});

describe('filterGroups', () => {
  const vm = toQualityViewModel(snapshot());

  it('returns everything with no filter', () => {
    expect(filterGroups(vm.groups, {})).toHaveLength(2);
  });

  it('filters by severity and drops groups left empty', () => {
    const critical = filterGroups(vm.groups, { severity: 'critical' });
    expect(critical).toHaveLength(1);
    expect(critical[0]!.issues.map((i) => i.rule)).toEqual(['ApexCRUDViolation']);
    expect(critical[0]!.worst).toBe('critical');
  });

  it('filters by engine', () => {
    const eslint = filterGroups(vm.groups, { engine: 'eslint' });
    expect(eslint).toHaveLength(1);
    expect(eslint[0]!.fileLabel).toBe('accountCard.js');
  });

  it('applies severity and engine together', () => {
    expect(filterGroups(vm.groups, { severity: 'critical', engine: 'eslint' })).toEqual([]);
  });

  it('never mutates the source groups', () => {
    filterGroups(vm.groups, { severity: 'critical' });
    expect(vm.groups[0]!.issues).toHaveLength(2);
  });
});

describe('presentation helpers', () => {
  it('gives SKIPPED and UNAVAILABLE a warning tone, never the success tone', () => {
    expect(statusPillClass('PASS')).toContain('sfdt-success');
    expect(statusPillClass('FAIL')).toContain('sfdt-error');
    expect(statusPillClass('SKIPPED')).toContain('sfdt-warning');
    expect(statusPillClass('UNAVAILABLE')).toContain('sfdt-warning');
  });

  it('tones severities by weight', () => {
    expect(severityPillClass('critical')).toContain('sfdt-error');
    expect(severityPillClass('high')).toContain('sfdt-error');
    expect(severityPillClass('medium')).toContain('sfdt-warning');
    expect(severityPillClass('low')).toBe('sfdt-pill');
  });

  it('summarises only the non-zero buckets, worst first', () => {
    expect(summaryLine({ critical: 1, high: 0, medium: 2, low: 3 })).toBe('1 critical · 2 medium · 3 low');
    expect(summaryLine({ critical: 0, high: 0, medium: 0, low: 0 })).toBe('');
  });
});
