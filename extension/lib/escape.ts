// The single shared HTML escape — always prefer this over manual replace
// chains so the rule set stays consistent.

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

// Tagged template literal: `html`<div>${userInput}</div>` escapes
// interpolations automatically.
export function html(strings: TemplateStringsArray, ...values: unknown[]): string {
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < values.length) out += escapeHtml(values[i]);
  }
  return out;
}

// SOQL string-literal escape. SOQL only treats `\` and `'` as special inside
// single-quoted string literals. Backslash MUST be escaped first or the
// quote's escape would itself be double-escaped on the second pass.
// Reference: https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/sforce_api_calls_soql_select_quotedstringescapes.htm
export function escapeSoql(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'string' ? value : String(value);
  return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}
