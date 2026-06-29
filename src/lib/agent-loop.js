import { runAiPrompt, providerSupportsAgenticTools } from './ai.js';
import { getPrompt } from './prompts.js';
import { redactSensitiveData } from './audit-logger.js';

/**
 * Bounded coding-agent auto-fix loop for failed deployments.
 *
 * Highest-risk feature in the suite: it grants the AI WRITE access to the repo,
 * intentionally overriding the read-only default elsewhere. Mitigations are
 * mandatory and layered:
 *   1. Off by default — requires ai.agent.enabled AND ai.agent.allowWrite.
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
  if (!agentCfg.enabled || !agentCfg.allowWrite) {
    return { ran: false, reason: 'ai.agent.enabled and ai.agent.allowWrite must both be true' };
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
    if (result?.ok) return { ran: true, fixed: true, turns };
    lastOutput = result?.output || lastOutput;
  }

  return { ran: true, fixed: false, turns };
}
