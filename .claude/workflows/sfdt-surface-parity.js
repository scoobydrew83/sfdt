export const meta = {
  name: 'sfdt-surface-parity',
  description: 'Triage sfdt CLI-to-surface parity gaps: intentional by design vs. real holes',
  whenToUse: 'After regenerating generated/surface-parity.json, or before a release, to find commands missing from the GUI, Chrome extension, or VS Code extension that should be there. Feed it args from tools/ or a jq pass over generated/surface-parity.json: [{surface, gaps:[{id, mcpTools}]}].',
  phases: [
    { title: 'Intent', detail: 'one agent per surface: derive its inclusion rule from code + docs, classify every gap' },
    { title: 'Refute', detail: 'adversarial check on each REAL_GAP claim - argue it is intentional' },
    { title: 'Report', detail: 'rank the surviving gaps' },
  ],
}

const SURFACE_DIR = {
  gui: 'gui/ (React + Vite dashboard, `sfdt ui`; catalog generated/gui-pages.json)',
  chrome: 'extension/ (Chrome extension; catalog generated/chrome-features.json, bridge contract generated/bridge-contract.json)',
  vscode: 'vscode/ (VS Code extension, CLI-backed; catalog generated/vscode-commands.json)',
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    inclusionRule: {
      type: 'string',
      description: 'The design rule that decides what belongs on this surface, in one or two sentences, grounded in what you actually read.',
    },
    ruleEvidence: { type: 'string', description: 'file:line or doc heading the rule came from' },
    classified: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['INTENTIONAL', 'REAL_GAP', 'UNDOCUMENTED'] },
          reason: { type: 'string' },
          evidence: { type: 'string', description: 'file:line, catalog entry, or doc line supporting the verdict' },
        },
        required: ['id', 'verdict', 'reason', 'evidence'],
      },
    },
  },
  required: ['inclusionRule', 'ruleEvidence', 'classified'],
}

const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean', description: 'true if this gap is actually intentional / not worth filing' },
    argument: { type: 'string' },
    evidence: { type: 'string' },
    userImpact: { type: 'string', description: 'if NOT refuted: who is blocked and by what, concretely' },
  },
  required: ['refuted', 'argument', 'evidence'],
}

const REFUTES_PER_SURFACE = 3

const results = await pipeline(
  args,

  // Stage 1 - derive the surface's real inclusion rule, then classify every gap against it.
  (item) => agent(
    `You are auditing the sfdt repo (CWD is the repo root) for CLI-to-surface parity.

SURFACE: \`${item.surface}\` - lives in ${SURFACE_DIR[item.surface]}

These ${item.gaps.length} CLI commands exist in the CLI but are absent from this surface, per generated/surface-parity.json:
${item.gaps.map(g => `  - ${g.id}${g.mcpTools.length ? `  (has ${g.mcpTools.length} MCP tool(s): ${g.mcpTools.join(', ')})` : ''}`).join('\n')}

STEP 1 - Find the inclusion rule. Read the surface's own code and the docs that govern it (docs/ARCHITECTURE.md for package topology and surface boundaries, docs/DEVELOPMENT.md's "changing a public surface" section, and the surface's catalog in generated/). Work out what this surface is actually FOR and what therefore belongs on it. Do not guess from the surface's name.

STEP 2 - Classify each command above against that rule:
  INTENTIONAL  - absent by design; the rule explains why (e.g. a shell-completion or self-update command has no business in a GUI).
  REAL_GAP     - a user would reasonably expect it here and its absence is a hole. A command that already has MCP tools but no UI is a strong signal.
  UNDOCUMENTED - plausibly deliberate, but nothing in the code or docs says so; the rule should be written down.

Be strict. Most absences on a purpose-built surface are INTENTIONAL - defaulting everything to REAL_GAP makes this audit useless. Cite a real file:line or doc heading for every verdict; never cite a file you did not open.

Note: generated/ is machine-generated and must never be hand-edited (golden principle #2). This is a read-only audit - change no files.`,
    { label: `intent:${item.surface}`, phase: 'Intent', schema: CLASSIFY_SCHEMA },
  ),

  // Stage 2 - adversarially refute this surface's REAL_GAP claims as soon as its stage 1 lands.
  (res, item) => {
    if (!res) return null
    // Only ids we actually handed the agent count; a misspelled or invented id is dropped.
    const known = new Set(item.gaps.map(g => g.id))
    const classified = res.classified.filter(c => known.has(c.id))
    const real = classified.filter(c => c.verdict === 'REAL_GAP')
    const bySignal = [...real].sort((a, b) => {
      const mt = id => (item.gaps.find(g => g.id === id)?.mcpTools.length ?? 0)
      return mt(b.id) - mt(a.id)
    })
    const picked = bySignal.slice(0, REFUTES_PER_SURFACE)
    const unverified = bySignal.slice(REFUTES_PER_SURFACE)
    if (unverified.length) {
      log(`${item.surface}: ${real.length} REAL_GAP claims, verifying the top ${picked.length} by MCP-tool signal - ${real.length - picked.length} carried forward unverified`)
    }
    // UNDOCUMENTED is where the drift signal lands ("the flag says false but the
    // feature ships"). Do NOT refute these - they are policy-vs-reality claims a
    // contract lint can settle mechanically. Carry them to the report untouched.
    const undocumented = classified.filter(c => c.verdict === 'UNDOCUMENTED')

    return parallel(picked.map(c => () =>
      agent(
        `You are the skeptic on a parity audit of the sfdt repo (CWD is the repo root).

Another agent claims this is a REAL GAP. Your job is to REFUTE it.

  Surface:      ${item.surface} - ${SURFACE_DIR[item.surface]}
  Command:      ${c.id}
  Their claim:  ${c.reason}
  Their evidence: ${c.evidence}
  Surface's inclusion rule (as they derived it): ${res.inclusionRule}

Open the files. Look for reasons this absence is correct: the command is interactive/TTY-bound, it mutates local dev state a browser or panel cannot own, it is already reachable another way on this surface, it is explicitly out of scope in the docs, or it is a CLI-lifecycle concern (install, completion, self-update).

Set refuted=true if the gap is intentional or not worth filing. Default to refuted=true when the evidence is thin or ambiguous - a false "this is missing!" costs the maintainer more than a missed nice-to-have. Only set refuted=false if you looked and genuinely could not find a reason for the absence; then say concretely who is blocked and by what.

Read-only - change no files.`,
        { label: `refute:${item.surface}/${c.id}`, phase: 'Refute', schema: REFUTE_SCHEMA },
      ).then(v => ({ surface: item.surface, claim: c, verdict: v }))
    )).then(checks => ({ surface: item.surface, checks, undocumented, unverified, rule: res.inclusionRule }))
  },
)

const perSurface = results.filter(Boolean)
const checked = perSurface.flatMap(s => s.checks).filter(Boolean).filter(r => r.verdict)
const survived = checked.filter(r => !r.verdict.refuted)
const killed = checked.filter(r => r.verdict.refuted)
const drift = perSurface.flatMap(s => s.undocumented.map(c => ({ surface: s.surface, ...c })))
const unverified = perSurface.flatMap(s => s.unverified.map(c => ({ surface: s.surface, ...c })))

log(`${checked.length} gap claims verified - ${survived.length} survived, ${killed.length} refuted; ${unverified.length} unverified and ${drift.length} undocumented/drift claims carried forward`)

if (!survived.length && !drift.length && !unverified.length) {
  return { survived: [], drift: [], unverified: [], killed: killed.length, report: 'No REAL_GAP claim survived adversarial review and no drift was flagged. Surface parity is intentional as far as this pass can tell.' }
}

phase('Report')
const report = await agent(
  `Write a short parity report for the sfdt maintainer. These CLI-to-surface gaps survived an adversarial review that was biased toward dismissing them, so treat each as credible.

${survived.map(r => `## \`${r.claim.id}\` missing from ${r.surface}
- why it matters: ${r.claim.reason}
- evidence: ${r.claim.evidence}
- skeptic could not refute it: ${r.verdict.argument}
- user impact: ${r.verdict.userImpact ?? 'not stated'}`).join('\n\n')}

Rank them by user impact, highest first. For each: one line on what shipping it involves (which files/catalog), and whether it is a code change or just a docs note recording the rule.

Then a second section, "Declared-intent drift". These are NOT missing features - they are commands whose \`surfaces\` flag in src/lib/command-policy.js disagrees with what the surface actually ships. \`surfaces\` is hand-authored declared intent, so generated/surface-parity.json inherits any staleness in it and cannot catch this class on its own.

${drift.map(d => `- \`${d.id}\` (${d.surface}): ${d.reason} [${d.evidence}]`).join('\n') || '- none'}

For that section, say which entries look like a stale flag to flip versus a genuinely undocumented decision to write down.

Then a third section, "Unverified gap claims". These were classified REAL_GAP but fell outside the per-surface refute budget, so nobody challenged them. List them as leads to check, not as findings:

${unverified.map(u => `- \`${u.id}\` (${u.surface}): ${u.reason} [${u.evidence}]`).join('\n') || '- none'}

Be concise - this goes straight into ROADMAP.md or TODO.md. No preamble.`,
  { label: 'report', phase: 'Report' },
)

return { survivedCount: survived.length, refutedCount: killed.length, driftCount: drift.length, unverifiedCount: unverified.length, survived, drift, unverified, report }
