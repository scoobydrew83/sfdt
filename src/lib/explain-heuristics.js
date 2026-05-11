const MAX_HEURISTIC_ERRORS = 20;

export const NO_MATCH_MESSAGE =
  'No known error patterns matched heuristically — AI analysis recommended.';

const HEURISTIC_PATTERNS = [
  {
    pattern: /No such column '([^']+)' on entity '([^']+)'/g,
    hint: (m) => `Missing field \`${m[1]}\` on \`${m[2]}\` — add the field to your manifest or create it.`,
  },
  {
    pattern: /Variable does not exist: (\w+)/g,
    hint: (m) => `Apex is referencing an unknown symbol \`${m[1]}\` — check imports and name.`,
  },
  {
    pattern: /Invalid type: (\w+)/g,
    hint: (m) => `Apex type \`${m[1]}\` is not defined in the target org.`,
  },
  {
    pattern: /Average test coverage across all Apex Classes and Triggers is (\d+)%/g,
    hint: (m) => `Overall coverage is ${m[1]}% — below the 75% org requirement.`,
  },
  {
    pattern: /Your organization must have at least \d+ percent code coverage/g,
    hint: () => 'Add tests or exclude low-coverage classes from this deployment.',
  },
  {
    pattern: /insufficient access rights on cross-reference id/gi,
    hint: () => 'A referenced record or metadata row is not visible to the deploying user.',
  },
  {
    pattern: /duplicate value found/gi,
    hint: () => 'A unique constraint (DeveloperName or external ID) collided — rename the component.',
  },
  {
    pattern: /Entity is not org-accessible/gi,
    hint: () => 'A referenced object/permission is not enabled in the target org.',
  },
];

/**
 * Run pattern-based heuristic analysis on a deployment log.
 * Returns { found: boolean, findings: string[], markdown: string }.
 */
export function runHeuristicAnalysis(logContent) {
  const findings = [];
  for (const { pattern, hint } of HEURISTIC_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(logContent)) !== null) {
      findings.push(hint(match));
      if (findings.length >= MAX_HEURISTIC_ERRORS) break;
    }
    if (findings.length >= MAX_HEURISTIC_ERRORS) break;
  }

  const deduped = [...new Set(findings)];

  if (deduped.length === 0) {
    return {
      found: false,
      findings: [],
      markdown: [
        '## Heuristic Scan Results',
        '',
        NO_MATCH_MESSAGE,
        '',
        '> Enable AI analysis in `.sfdt/config.json` (`features.ai: true`) for deeper root cause analysis.',
      ].join('\n'),
    };
  }

  const bullets = deduped.map((h) => `- ${h}`).join('\n');
  return {
    found: true,
    findings: deduped,
    markdown: [
      '## Heuristic Scan Results',
      '',
      'The following issues were detected by pattern analysis:',
      '',
      bullets,
      '',
      '> Enable AI analysis in `.sfdt/config.json` (`features.ai: true`) for deeper root cause analysis.',
    ].join('\n'),
  };
}
