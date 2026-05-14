// The one shared HTML escape used by every feature module. v2.0.2 had three
// near-duplicate implementations across the codebase (regex-based and
// DOM-based variants); this module supersedes all of them. Always prefer
// `escapeHtml` over manual replace chains so the rule set stays consistent.

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '/': '&#x2F;',
};

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.replace(/[&<>"'/]/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

// Convenience: tagged template literal so callers can write
//   const html = html`<div>${userInput}</div>`;
// without sprinkling escapeHtml() in every interpolation.
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += escapeHtml(values[i]);
  }
  return out;
}
