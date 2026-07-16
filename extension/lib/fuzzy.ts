// Hand-rolled fuzzy matcher for the command palette. No dependency, no DOM —
// pure string scoring so it stays trivially unit-testable and adds zero runtime
// weight (CLAUDE.md rule 6: no new runtime deps; the matcher is ours).
//
// Ranking tiers, highest score wins, non-overlapping bands so the ordering
// "exact/prefix > substring > word-boundary subsequence > loose subsequence"
// always holds regardless of string length:
//
//   exact                1000
//   prefix                802..900
//   substring (contains)  702..800
//   word-boundary subseq  500..699
//   loose subsequence     100..399
//   no match              null

const EXACT = 1000;
const PREFIX_BASE = 900;
const CONTAINS_BASE = 800;
const WORD_BOUNDARY_BASE = 500;
const LOOSE_BASE = 100;

/**
 * Score `candidate` against `query`. Higher is better; `null` = no match.
 * Case-insensitive. An empty/whitespace query matches everything at score 0
 * (the caller decides whether to show all candidates when the box is empty).
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase().trim();
  if (q === '') return 0;
  const c = candidate.toLowerCase();

  if (c === q) return EXACT;
  if (c.startsWith(q)) return PREFIX_BASE - Math.min(c.length - q.length, 98);

  const idx = c.indexOf(q);
  if (idx !== -1) return CONTAINS_BASE - Math.min(idx, 49) - Math.min(c.length - q.length, 49);

  const wb = wordBoundaryScore(q, candidate);
  if (wb !== null) return wb;

  return looseSubsequenceScore(q, c);
}

/**
 * Score a candidate that carries both an api-name key and a human label —
 * returns the better (higher) of the two, or null if neither matches. Undefined
 * keys are skipped, so callers can pass an optional api name.
 */
export function fuzzyScoreFields(
  query: string,
  ...keys: Array<string | undefined | null>
): number | null {
  let best: number | null = null;
  for (const key of keys) {
    if (key == null) continue;
    const s = fuzzyScore(query, key);
    if (s !== null && (best === null || s > best)) best = s;
  }
  return best;
}

/**
 * Stable descending sort by a numeric score: equal scores keep their input
 * order. (Array.sort is spec-stable on modern engines, but the explicit index
 * tiebreaker documents the guarantee and can't regress.)
 */
export function stableSortByScore<T>(items: readonly T[], score: (item: T) => number): T[] {
  return items
    .map((item, i) => ({ item, i, s: score(item) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.item);
}

// Query chars must match, in order, only at word boundaries of the candidate:
// index 0, the char after a non-alphanumeric separator, or a lower→upper camel
// hump. Boundaries are computed on the ORIGINAL candidate (camelCase is lost
// once lowercased). More boundaries consumed contiguously => higher score.
function wordBoundaryScore(q: string, candidate: string): number | null {
  const boundaries: number[] = [];
  for (let i = 0; i < candidate.length; i++) {
    const ch = candidate.charAt(i);
    if (!/[a-z0-9]/i.test(ch)) continue;
    const prev = candidate.charAt(i - 1); // '' at i === 0
    const isStart = i === 0;
    const afterSep = prev !== '' && !/[a-z0-9]/i.test(prev);
    const camelHump = /[a-z]/.test(prev) && /[A-Z]/.test(ch);
    if (isStart || afterSep || camelHump) boundaries.push(i);
  }

  let qi = 0;
  let matched = 0;
  for (const b of boundaries) {
    if (qi >= q.length) break;
    if (candidate.charAt(b).toLowerCase() === q.charAt(qi)) {
      qi++;
      matched++;
    }
  }
  if (qi < q.length) return null;
  // Reward covering the query with fewer boundaries (a tight acronym).
  return WORD_BOUNDARY_BASE + Math.min(matched * 10, 199);
}

// Query chars appear in order anywhere in the candidate. Reward contiguous runs
// and an early first match, so "compact" hits rank above scattered ones.
function looseSubsequenceScore(q: string, c: string): number | null {
  let qi = 0;
  let firstIdx = -1;
  let contiguous = 0;
  let lastMatch = -2;
  for (let i = 0; i < c.length && qi < q.length; i++) {
    if (c.charAt(i) === q.charAt(qi)) {
      if (firstIdx === -1) firstIdx = i;
      if (i === lastMatch + 1) contiguous++;
      lastMatch = i;
      qi++;
    }
  }
  if (qi < q.length) return null;
  const earlyBonus = Math.max(0, 60 - firstIdx);
  return LOOSE_BASE + Math.min(contiguous * 20 + earlyBonus, 299);
}
