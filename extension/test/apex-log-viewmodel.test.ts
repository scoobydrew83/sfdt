import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseApexLog } from '../lib/apex-log/index.js';
import {
  buildAnalyzerViewModel,
  sortMethodRows,
  formatNanosMs,
  type MethodRow,
} from '../lib/apex-log/viewmodel.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'apex-log',
);
const load = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

// A tiny synthetic log where one method (Svc.doThing()) is invoked twice, so the
// aggregation (count 2, summed total/self) is exact and easy to assert.
const TWICE_LOG = [
  '64.0 APEX_CODE,FINEST;SYSTEM,FINE',
  'Execution log',
  '09:00:00.001 (1000)|EXECUTION_STARTED',
  '09:00:00.001 (2000)|CODE_UNIT_STARTED|[EXTERNAL]|01q5j000000AbCdEAK|MyTrigger on Account trigger event BeforeUpdate|__sfdc_trigger/MyTrigger',
  '09:00:00.001 (3000)|METHOD_ENTRY|[12]|01p5j000000XyZwAAK|Svc.doThing()',
  '09:00:00.001 (8000)|METHOD_EXIT|[12]|01p5j000000XyZwAAK|Svc.doThing()',
  '09:00:00.001 (9000)|METHOD_ENTRY|[20]|01p5j000000XyZwAAK|Svc.doThing()',
  '09:00:00.001 (14000)|METHOD_EXIT|[20]|01p5j000000XyZwAAK|Svc.doThing()',
  '09:00:00.001 (15000)|CODE_UNIT_FINISHED|MyTrigger on Account trigger event BeforeUpdate',
  '09:00:00.001 (16000)|EXECUTION_FINISHED',
  '',
].join('\n');

describe('apex-log viewmodel — buildAnalyzerViewModel', () => {
  it('aggregates a method invoked twice into one row with count 2 and summed timings', () => {
    const vm = buildAnalyzerViewModel(parseApexLog(TWICE_LOG));
    const row = vm.methods.find((m) => m.name === 'Svc.doThing()');
    expect(row).toBeDefined();
    expect(row!.count).toBe(2);
    // Each invocation was a leaf lasting 5000ns → total & self are 10000 combined.
    expect(row!.totalNanos).toBe(10_000);
    expect(row!.selfNanos).toBe(10_000);
  });

  it('emits one row per unique method/code-unit name and skips the execution root', () => {
    const vm = buildAnalyzerViewModel(parseApexLog(TWICE_LOG));
    const names = vm.methods.map((m) => m.name);
    // No duplicate rows for the repeated method.
    expect(names.filter((n) => n === 'Svc.doThing()')).toHaveLength(1);
    // The code-unit is a row; the execution frame is not.
    expect(names).toContain('__sfdc_trigger/MyTrigger');
    expect(vm.methods.some((m) => m.count > 0)).toBe(true);
  });

  it('default-sorts methods by total time descending', () => {
    const vm = buildAnalyzerViewModel(parseApexLog(load('deep-nesting.log')));
    for (let i = 1; i < vm.methods.length; i++) {
      expect(vm.methods[i - 1]!.totalNanos).toBeGreaterThanOrEqual(vm.methods[i]!.totalNanos);
    }
  });

  it('passes governor-limit snapshots through unchanged', () => {
    const parsed = parseApexLog(load('managed-package.log'));
    const vm = buildAnalyzerViewModel(parsed);
    expect(vm.limits).toBe(parsed.limits);
    expect(vm.limits.length).toBeGreaterThan(0);
  });

  it('passes soql/dml/callout inventories through with their line + node shape', () => {
    const parsed = parseApexLog(load('soql-dml-heavy.log'));
    const vm = buildAnalyzerViewModel(parsed);
    expect(vm.soql).toBe(parsed.soql);
    expect(vm.dml).toBe(parsed.dml);
    expect(vm.callouts).toBe(parsed.callouts);
    expect(vm.soql.length).toBeGreaterThan(0);
    for (const q of vm.soql) expect(typeof q.line).toBe('number');
  });

  it('surfaces the truncation flag + reason', () => {
    const vm = buildAnalyzerViewModel(parseApexLog(load('truncated.log')));
    expect(vm.truncated).toBe(true);
    expect(vm.truncationReason).toBe('MAXIMUM_DEBUG_LOG_SIZE_REACHED');
  });

  it('handles a non-truncated log (flag false, reason null)', () => {
    const vm = buildAnalyzerViewModel(parseApexLog(TWICE_LOG));
    expect(vm.truncated).toBe(false);
    expect(vm.truncationReason).toBeNull();
  });
});

describe('apex-log viewmodel — sortMethodRows', () => {
  const rows: MethodRow[] = [
    { name: 'a', namespace: null, totalNanos: 10, selfNanos: 3, count: 1 },
    { name: 'b', namespace: null, totalNanos: 30, selfNanos: 1, count: 2 },
    { name: 'c', namespace: null, totalNanos: 20, selfNanos: 2, count: 2 },
  ];

  it('sorts by total desc', () => {
    expect(sortMethodRows(rows, 'total').map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
  it('sorts by self desc', () => {
    expect(sortMethodRows(rows, 'self').map((r) => r.name)).toEqual(['a', 'c', 'b']);
  });
  it('sorts by count desc, stable on ties', () => {
    // b and c both count 2 → keep input order (b before c).
    expect(sortMethodRows(rows, 'count').map((r) => r.name)).toEqual(['b', 'c', 'a']);
  });
  it('does not mutate the input array', () => {
    const before = rows.map((r) => r.name);
    sortMethodRows(rows, 'total');
    expect(rows.map((r) => r.name)).toEqual(before);
  });
});

describe('apex-log viewmodel — formatNanosMs', () => {
  it('renders nanoseconds as milliseconds with 2 decimals', () => {
    expect(formatNanosMs(10_000_000)).toBe('10.00 ms');
    expect(formatNanosMs(1_234_567)).toBe('1.23 ms');
    expect(formatNanosMs(0)).toBe('0.00 ms');
  });
});
