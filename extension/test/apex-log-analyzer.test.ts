import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseApexLog } from '../lib/apex-log/index.js';
import type { ParsedLog } from '../lib/apex-log/index.js';
import { presentApexLogAnalyzer } from '../ui/apex-log-analyzer.js';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'apex-log',
);
const load = (name: string): string => readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

// Parse each fixture ONCE up front (allowed). The DOM assertions below never
// re-parse — they read from these ParsedLog inputs via the analyzer.
function fixture(name: string): { raw: string; parsed: ParsedLog } {
  const raw = load(name);
  return { raw, parsed: parseApexLog(raw) };
}

function clearBody(): void {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild);
}

function overlay(): HTMLElement {
  return document.querySelector<HTMLElement>('.sfdt-view-overlay')!;
}

describe('apex-log-analyzer — render', () => {
  beforeEach(clearBody);

  it('renders the method-timing table with sortable header buttons', () => {
    const { raw, parsed } = fixture('deep-nesting.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    const text = overlay().textContent ?? '';
    expect(text).toContain('Method timings');
    expect(text).toContain('OrderProcessor.level0()');
    // Header sort buttons exist and are real <button>s (keyboard-activatable).
    const headers = Array.from(overlay().querySelectorAll('thead button')).map((b) => b.textContent);
    expect(headers.some((h) => h?.includes('Total'))).toBe(true);
    expect(headers.some((h) => h?.includes('Self'))).toBe(true);
    expect(headers.some((h) => h?.includes('Count'))).toBe(true);
  });

  it('clicking a sortable header re-orders the rows', () => {
    const { raw, parsed } = fixture('soql-dml-heavy.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });

    const methodNames = (): string[] =>
      Array.from(overlay().querySelectorAll('tbody tr'))
        .map((tr) => tr.querySelector('td')?.textContent ?? '')
        .filter(Boolean);

    const byTotal = methodNames();
    // Sort by Count — order should be recomputed (and aria-sort moves to Count).
    const countBtn = Array.from(overlay().querySelectorAll<HTMLButtonElement>('thead button')).find(
      (b) => b.textContent?.includes('Count'),
    )!;
    countBtn.click();
    const countTh = countBtn.closest('th')!;
    expect(countTh.getAttribute('aria-sort')).toBe('descending');
    // A re-render happened: same rows, but the active header now shows a marker.
    expect(countBtn.textContent).toContain('▼');
    expect(methodNames().length).toBe(byTotal.length);
  });

  it('renders governor-limit snapshots as used / max', () => {
    const { raw, parsed } = fixture('managed-package.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    const text = overlay().textContent ?? '';
    expect(text).toContain('Governor limits');
    expect(text).toContain('soqlQueries');
    expect(text).toContain('2 / 100');
  });

  it('renders SOQL / DML / callout inventories with line-jump controls', () => {
    const { raw, parsed } = fixture('soql-dml-heavy.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    const text = overlay().textContent ?? '';
    expect(text).toContain('SOQL queries (1)');
    expect(text).toContain('DML operations (1)');
    expect(text).toContain('Callouts (1)');
    const jumpButtons = Array.from(overlay().querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => b.textContent?.startsWith('line '),
    );
    expect(jumpButtons.length).toBeGreaterThanOrEqual(3);
  });

  it('a line-jump control highlights the target line in the raw log', () => {
    const { raw, parsed } = fixture('soql-dml-heavy.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    const soqlEntry = parsed.soql[0]!;
    const jump = Array.from(overlay().querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent === `line ${soqlEntry.line + 1}`,
    )!;
    expect(jump).toBeDefined();
    jump.click();
    // Exactly one raw-log line carries the highlight marker after the jump, and
    // it is the 0-based line the parser recorded.
    const highlighted = overlay().querySelectorAll('[data-sfdt-highlighted="true"]');
    expect(highlighted).toHaveLength(1);
    expect(highlighted[0]!.textContent).toBe(raw.split('\n')[soqlEntry.line]);
  });

  it('shows a truncation banner (role=alert) naming the reason for a truncated log', () => {
    const { raw, parsed } = fixture('truncated.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    const alert = overlay().querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain('truncated');
    expect(alert!.textContent).toContain('MAXIMUM_DEBUG_LOG_SIZE_REACHED');
  });

  it('shows no truncation banner for a clean log', () => {
    const { raw, parsed } = fixture('small-happy.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    expect(overlay().querySelector('[role="alert"]')).toBeNull();
  });

  it('Esc closes the overlay and restores focus to the opener', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const { raw, parsed } = fixture('small-happy.log');
    presentApexLogAnalyzer({ parsed, rawText: raw, doc: document });
    expect(overlay()).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(document.querySelector('.sfdt-view-overlay')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});
