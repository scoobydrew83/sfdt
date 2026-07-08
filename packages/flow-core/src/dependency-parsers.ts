// Pure, browser-safe heuristic extractors for dependency edges that Salesforce's
// MetadataComponentDependency Tooling API does not record. Regex/string only —
// no fs, no org, no XML-parser dependency. Best-effort by design.

export type InferredRefKind =
  | 'apex-dynamic'
  | 'apex-string'
  | 'lwc-apex'
  | 'formula'
  | 'flow-subflow'
  | 'flow-action'
  | 'flow-field';

export interface InferredRef {
  /** Referenced component/field API name (best-effort). */
  toName: string;
  /** Best-effort metadata type of the referenced thing, or 'unknown'. */
  toType: string;
  kind: InferredRefKind;
  /** The matched source snippet. */
  evidence: string;
  /** 1-based line the match started on (1 if unknown). */
  line: number;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  const end = Math.min(index, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function dedupe(refs: InferredRef[]): InferredRef[] {
  const seen = new Set<string>();
  const out: InferredRef[] = [];
  for (const r of refs) {
    const k = `${r.kind}|${r.toType}|${r.toName}`;
    if (!seen.has(k)) { seen.add(k); out.push(r); }
  }
  return out;
}

/** Object names in a SOQL string's FROM clause(s). */
function objectsFromSoql(soql: string): string[] {
  const out: string[] = [];
  const from = /\bFROM\s+([A-Za-z][\w]*(?:__c)?)/gi;
  let m: RegExpExecArray | null;
  while ((m = from.exec(soql)) !== null) out.push(m[1]!);
  return out;
}

/** Dynamic/string Apex references (Type.forName, Database.query, getGlobalDescribe). */
export function extractApexRefs(body: string): InferredRef[] {
  const refs: InferredRef[] = [];
  let m: RegExpExecArray | null;

  const forName = /Type\.forName\(\s*'([^']+)'(?:\s*,\s*'([^']+)')?\s*\)/g;
  while ((m = forName.exec(body)) !== null) {
    const cls = m[2] ?? m[1]!;
    const evidence = m[2] ? `Type.forName('${m[1]!}','${m[2]}')` : `Type.forName('${m[1]!}')`;
    refs.push({ toName: cls, toType: 'ApexClass', kind: 'apex-dynamic', evidence, line: lineAt(body, m.index) });
  }

  const dbq = /Database\.query(?:WithBinds)?\(\s*'([^']*)'/g;
  while ((m = dbq.exec(body)) !== null) {
    const idx = m.index;
    for (const obj of objectsFromSoql(m[1]!)) {
      refs.push({ toName: obj, toType: 'CustomObject', kind: 'apex-dynamic', evidence: `Database.query('… FROM ${obj} …')`, line: lineAt(body, idx) });
    }
  }

  const ggd = /Schema\.getGlobalDescribe\(\)/g;
  while ((m = ggd.exec(body)) !== null) {
    refs.push({ toName: '(all objects)', toType: 'CustomObject', kind: 'apex-dynamic', evidence: 'Schema.getGlobalDescribe()', line: lineAt(body, m.index) });
  }

  return dedupe(refs);
}

/** LWC `@salesforce/apex/Class.method` imports → the Apex class. */
export function extractLwcApexRefs(js: string): InferredRef[] {
  const re = /@salesforce\/apex\/([\w.]+)/g;
  const refs: InferredRef[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(js)) !== null) {
    const cls = m[1]!.split('.')[0]!;
    refs.push({ toName: cls, toType: 'ApexClass', kind: 'lwc-apex', evidence: m[0]!, line: lineAt(js, m.index) });
  }
  return dedupe(refs);
}

// Common formula function/operator names to ignore when scanning for field refs.
const FORMULA_KEYWORDS = new Set([
  'IF', 'AND', 'OR', 'NOT', 'TEXT', 'VALUE', 'LEN', 'TRIM', 'ABS', 'ROUND',
  'MIN', 'MAX', 'MOD', 'FLOOR', 'CEILING', 'SQRT', 'ISBLANK', 'ISNULL', 'BLANKVALUE',
  'NULLVALUE', 'ISPICKVAL', 'ISNUMBER', 'ISCHANGED', 'PRIORVALUE', 'TODAY', 'NOW',
  'DATE', 'DATEVALUE', 'DATETIMEVALUE', 'YEAR', 'MONTH', 'DAY', 'BEGINS', 'CONTAINS',
  'INCLUDES', 'SUBSTITUTE', 'LEFT', 'RIGHT', 'MID', 'UPPER', 'LOWER', 'FIND', 'HYPERLINK',
  'IMAGE', 'REGEX', 'TRUE', 'FALSE', 'NULL',
]);

/** Field/object references inside a custom field's <formula>. */
export function extractFormulaRefs(fieldXml: string): InferredRef[] {
  const fm = /<formula>([\s\S]*?)<\/formula>/i.exec(fieldXml);
  if (!fm) return [];
  const formula = fm[1]!;
  const refs: InferredRef[] = [];
  // Relationship-qualified refs first (e.g. Territory__r.Code__c, Account.Name).
  const dotted = /\b([A-Za-z]\w*)\.([A-Za-z]\w*(?:__c|__r)?)\b/g;
  let m: RegExpExecArray | null;
  while ((m = dotted.exec(formula)) !== null) {
    const head = m[1]!;
    if (!FORMULA_KEYWORDS.has(head.toUpperCase())) {
      const toType = 'CustomObject';
      refs.push({ toName: head, toType, kind: 'formula', evidence: `${m[1]!}.${m[2]!}`, line: 1 });
    }
  }
  // Bare custom field tokens (Region__c).
  const tokens = /\b[A-Za-z]\w*__c\b/g;
  while ((m = tokens.exec(formula)) !== null) {
    refs.push({ toName: m[0]!, toType: 'CustomField', kind: 'formula', evidence: m[0]!, line: 1 });
  }
  return dedupe(refs);
}

/** Subflow / apex-action / record-object references from a .flow-meta.xml body. */
export function extractFlowRefs(xml: string): InferredRef[] {
  const refs: InferredRef[] = [];
  let m: RegExpExecArray | null;

  const subflow = /<subflows\b[\s\S]*?<flowName>([^<]+)<\/flowName>[\s\S]*?<\/subflows>/g;
  while ((m = subflow.exec(xml)) !== null) {
    refs.push({ toName: m[1]!.trim(), toType: 'Flow', kind: 'flow-subflow', evidence: `subflow ${m[1]!.trim()}`, line: lineAt(xml, m.index) });
  }

  const action = /<actionCalls\b([\s\S]*?)<\/actionCalls>/g;
  while ((m = action.exec(xml)) !== null) {
    const block = m[1]!;
    const nameM = /<actionName>([^<]+)<\/actionName>/.exec(block);
    if (!nameM) continue;
    const typeM = /<actionType>([^<]+)<\/actionType>/.exec(block);
    const isApex = !!typeM && typeM[1]!.trim() === 'apex';
    refs.push({ toName: nameM[1]!.trim(), toType: isApex ? 'ApexClass' : 'unknown', kind: 'flow-action', evidence: `action ${nameM[1]!.trim()}`, line: lineAt(xml, m.index) });
  }

  const obj = /<object>([^<]+)<\/object>/g;
  while ((m = obj.exec(xml)) !== null) {
    refs.push({ toName: m[1]!.trim(), toType: 'CustomObject', kind: 'flow-field', evidence: `object ${m[1]!.trim()}`, line: lineAt(xml, m.index) });
  }

  return dedupe(refs);
}
