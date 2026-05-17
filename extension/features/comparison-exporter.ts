// Comparison Exporter — minimal port of
// /Users/dkennedy/dev/2.0.2_0 copy/features/comparison-exporter.js.
//
// The v2.0.2 module scrapes the Compare Flows view and writes a pre-formatted
// XLSX (using the bundled `lib/xlsx.bundle.js`). The XLSX bundle is heavy
// (~600 kB) and lives outside the WXT module graph; deferring full XLSX
// generation to Phase 7 when the asset is wired through `public/`.
//
// This port preserves the user-facing surface: a feature that activates on
// the Compare Flows view, scrapes the diff rows, and exports them as a
// plain-text TSV the user can paste into Excel. When the xlsx asset is
// wired, the only change required is to feed `rows` into a workbook writer
// instead of joining them.

import { detectContext, CONTEXTS } from '../lib/context-detector.js';
import type { Feature } from '../lib/feature-registry.js';
import { showToast } from '../ui/toast.js';

interface DiffRow {
  element: string;
  change: string;
  fieldChanged: string;
  oldValue: string;
  newValue: string;
}

function scrapeDiffRows(doc: Document): DiffRow[] {
  const rows: DiffRow[] = [];
  // The selectors mirror v2.0.2's scrape — Salesforce's Compare Versions table.
  const trs = doc.querySelectorAll('table.slds-table tbody tr');
  for (const tr of trs) {
    const cells = Array.from(tr.querySelectorAll('td'));
    if (cells.length < 5) continue;
    rows.push({
      element: (cells[0]?.textContent ?? '').trim(),
      change: (cells[1]?.textContent ?? '').trim(),
      fieldChanged: (cells[2]?.textContent ?? '').trim(),
      oldValue: (cells[3]?.textContent ?? '').trim(),
      newValue: (cells[4]?.textContent ?? '').trim(),
    });
  }
  return rows;
}

function toTsv(rows: readonly DiffRow[]): string {
  const header = ['Element', 'Change', 'Field Changed', 'Old Value', 'New Value'].join('\t');
  const escape = (s: string) => s.replace(/\t/g, ' ').replace(/\n+/g, ' ');
  const lines = rows.map((r) =>
    [r.element, r.change, r.fieldChanged, r.oldValue, r.newValue].map(escape).join('\t'),
  );
  return [header, ...lines].join('\n');
}

function triggerDownload(doc: Document, filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface ComparisonExporterOptions {
  doc?: Document;
  win?: Window;
}

export function createComparisonExporterFeature(
  options: ComparisonExporterOptions = {},
): Feature {
  const doc = options.doc ?? document;
  const win = options.win ?? window;

  return {
    manifest: {
      id: 'comparison-exporter',
      name: 'Comparison Exporter',
      contexts: [CONTEXTS.COMPARE_FLOWS],
    },

    onActivate() {
      if (detectContext({ location: { href: win.location.href } }, doc) !== CONTEXTS.COMPARE_FLOWS) {
        showToast('Open the Compare Flows view to export.', { kind: 'warning', doc });
        return;
      }
      const rows = scrapeDiffRows(doc);
      if (rows.length === 0) {
        showToast('No comparison rows found to export.', { kind: 'warning', doc });
        return;
      }
      const tsv = toTsv(rows);
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      triggerDownload(doc, `flow-comparison-${stamp}.tsv`, tsv, 'text/tab-separated-values');
      showToast(`Exported ${rows.length} comparison row${rows.length === 1 ? '' : 's'}.`, {
        kind: 'success',
        doc,
      });
    },
  };
}

export function _comparisonExporterTestApi() {
  return { scrapeDiffRows, toTsv };
}
