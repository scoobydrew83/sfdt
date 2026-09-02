import path from 'path';
import { runAiPrompt, providerSupportsAgenticTools } from './ai.js';
import { AI_WRITE_ENV_VAR } from './config-trust.js';
import { getPrompt } from './prompts.js';
import { redactSensitiveData } from './audit-logger.js';
import { recordRun } from './run-history.js';
import { mirrorTelemetry } from './harness-telemetry.js';

/**
 * Bounded coding-agent auto-fix loop for failed deployments.
 *
 * Highest-risk feature in the suite: it grants the AI WRITE access to the repo,
 * intentionally overriding the read-only default elsewhere. Mitigations are
 * mandatory and layered:
 *   1. Off by default — requires `SFDT_ALLOW_AI_WRITE=1` in the *operator's*
 *      environment. It used to require `ai.agent.enabled` AND
 *      `ai.agent.allowWrite`, both read from `.sfdt/config.json` — a file that
 *      is committed, so a cloned repo could set both and hand its own
 *      attacker-authored prompt an `Edit` tool in the victim's checkout
 *      (sfdt-private#14, H1). Two booleans in an attacker-controlled file are
 *      one gate, not two. The grant has to arrive over a channel the repository
 *      does not control, which is the same reasoning `config-trust.js` sets out
 *      for `SFDT_ALLOW_UNSAFE_CONFIG` — and a separate variable from it,
 *      because trusting a repo's plugin list is a far smaller decision than
 *      handing a model write access.
 *   2. CLI providers only — the http provider can't run tools, so it's excluded.
 *   3. Bounded — at most maxTurns iterations.
 *   4. Re-validates via the caller's dry-run `validate()` each turn before any
 *      real deploy; the loop never deploys, it only edits + validates.
 *   5. The attacker-influenceable failure output is run through
 *      redactSensitiveData before being placed in the prompt.
 *
 * @param {object} params
 * @param {string} params.failureOutput - captured deploy/validate failure output.
 * @param {object} params.config
 * @param {string} params.projectRoot
 * @param {string} params.org
 * @param {() => Promise<{ok: boolean, output: string}>} params.validate - re-run
 *   validation (dry-run); resolves to success + fresh output. Injected so this
 *   module stays free of execa and is unit-testable.
 * @param {number} [params.maxTurns]
 * @returns {Promise<{ran: boolean, reason?: string, fixed?: boolean, turns?: Array}>}
 */
export async function runFixLoop({ failureOutput, config, projectRoot, org, validate, maxTurns } = {}) {
  const agentCfg = config?.ai?.agent || {};
  if (process.env[AI_WRITE_ENV_VAR] !== '1') {
    return {
      ran: false,
      reason:
        `the write-capable auto-fix loop must be granted from your environment, not from ` +
        `.sfdt/config.json — export ${AI_WRITE_ENV_VAR}=1 to enable it`,
    };
  }
  if (!providerSupportsAgenticTools(config)) {
    return { ran: false, reason: 'auto-fix requires an agentic CLI provider (claude | gemini | openai), not http' };
  }
  if (typeof validate !== 'function') {
    return { ran: false, reason: 'no validate() callback provided' };
  }

  const limit = Math.max(1, Math.min(20, maxTurns ?? agentCfg.maxTurns ?? 3));
  const basePrompt = await getPrompt('deploy-error', config._configDir);
  const turns = [];
  let lastOutput = failureOutput;
  const started = Date.now();

  // Persist the loop outcome to run-history so agent-fix runs can be trended,
  // not discarded by the caller. Best-effort (recordRun never throws).
  const finish = async (outcome) => {
    const logDir = config?.logDir ?? (projectRoot ? path.join(projectRoot, 'logs') : null);
    const base = {
      type: 'agent-fix',
      status: outcome.fixed ? 'pass' : 'fail',
      summary: { turns: outcome.turns.length, ran: outcome.ran },
    };
    await recordRun(logDir, { ...base, org, durationMs: Date.now() - started });
    // Mirror into the tracked JSONL so agent-fix rows reach the weekly improver
    // in CI — the db above is gitignored and never leaves this machine. Only
    // when SFDT_HARNESS_TELEMETRY names a path (the sfdt dev checkout); see
    // harness-telemetry.js for why this is opt-in rather than automatic.
    // `org` is deliberately not mirrored: that file is committed to a public
    // repo, and the improver clusters by category, never by org.
    mirrorTelemetry({ ...base, timestamp: new Date().toISOString() }, process.env.SFDT_HARNESS_TELEMETRY);
    return outcome;
  };

  for (let i = 1; i <= limit; i++) {
    const redacted = String(redactSensitiveData(lastOutput) || '').slice(0, 12000);
    const prompt =
      `${basePrompt}\n\n` +
      `You MAY edit files in this repository to fix the failure, then stop. Make the smallest change ` +
      `that resolves the error — do not refactor unrelated code and do not deploy.\n\n` +
      `TARGET ORG: ${org}\n\nDEPLOYMENT OUTPUT:\n${redacted}`;

    await runAiPrompt(prompt, {
      config,
      allowedTools: ['Read', 'Grep', 'Glob', 'Edit', 'Bash(sf project deploy validate:*)'],
      cwd: projectRoot,
      aiEnabled: true,
      interactive: false,
    });

    const result = await validate();
    turns.push({ turn: i, ok: !!result?.ok });
    if (result?.ok) return finish({ ran: true, fixed: true, turns });
    lastOutput = result?.output || lastOutput;
  }

  return finish({ ran: true, fixed: false, turns });
}
