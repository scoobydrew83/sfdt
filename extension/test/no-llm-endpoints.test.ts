// C-P4-5 AC-1, as a guard rather than as a promise.
//
// The extension has two AI-shaped features now — features/ai-assistant.ts and
// features/soql-nl-generate.ts — and neither of them may talk to a model. Every
// prompt goes to the local sfdt CLI over the existing bridge
// (`createBridgeClient(...).call({ kind: 'ai', … })`), and the CLI owns the
// provider, the API key, the redaction pass and the anti-injection preamble.
//
// That arrangement is worth exactly as much as the thing that stops the next
// change from short-circuiting it, so be honest about what that thing is.
//
// It is NOT the manifest. An earlier version of this comment said adding an LLM
// endpoint "would need a provider host, a key, and (because of the manifest's
// host_permissions allowlist) a new permission". That claim was wrong and is
// withdrawn — the same retraction is on PR #328. The built manifest declares no
// content_security_policy, so there is no connect-src restriction, and a fetch
// to a cooperating host answering `Access-Control-Allow-Origin: *` succeeds from
// a content script or the worker regardless of host_permissions. That allowlist
// is a real backstop against reading origins you have no permission for; it is
// not one against a deliberately-added exfil call.
//
// What actually guards this today is a source-level lint over two files — the
// fetch/XHR/WebSocket/EventSource ban below, scoped to features/ai-assistant.ts
// and features/soql-nl-generate.ts — plus review. The same fetch added to a
// non-AI feature passes every gate in this repo. Closing that properly means a
// scoped no-restricted-globals fetch ban over features/** + ui/**, or a
// connect-src CSP; neither exists yet, and this file must not imply otherwise.
// The host_permissions assertion at the bottom still earns its keep as a
// tripwire on the permission ledger — it is not an egress control.
//
// Golden principle #12: the only thing excluded from the scan is this file
// itself, listed by name in DEFINING_ARTIFACTS with a reason. The docs that
// describe the rule are not excluded — they are simply outside SCANNED_DIRS.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(HERE, '..');

// Everything that ships in the bundle.
const SCANNED_DIRS = ['features', 'ui', 'lib', 'entrypoints'];

/**
 * Hostnames belonging to a model provider. A literal here in shipped code is
 * the violation this whole item was constrained around — there is no legitimate
 * reason for the extension to know one.
 */
const PROVIDER_HOSTS: readonly string[] = [
  'api.anthropic.com',
  'api.openai.com',
  'openai.azure.com',
  'generativelanguage.googleapis.com',
  'api.cohere.ai',
  'api.mistral.ai',
  'api.groq.com',
  'api.together.xyz',
  'openrouter.ai',
  'api.perplexity.ai',
  'api.deepseek.com',
  'bedrock-runtime',
  'aiplatform.googleapis.com',
];

/**
 * Credential names. The extension stores exactly one secret — the bridge token
 * — and holds no provider key of any kind.
 */
const KEY_PATTERNS: readonly RegExp[] = [
  /\bANTHROPIC_API_KEY\b/,
  /\bOPENAI_API_KEY\b/,
  /\bGEMINI_API_KEY\b/,
  /\bGOOGLE_API_KEY\b/,
  /\bx-api-key\b/i,
  /\bapiKey\s*:/,
  /\bsk-[A-Za-z0-9]{16,}/,
];

/**
 * Files that DEFINE the rule and therefore cannot break it.
 *
 * Currently only this test. `lib/sfdt-bridge.ts` is deliberately NOT listed:
 * it is the sanctioned transport and its only hosts are 127.0.0.1/localhost,
 * which the scan does not object to, so it passes on its merits.
 */
const DEFINING_ARTIFACTS: { file: string; because: string }[] = [
  {
    file: 'test/no-llm-endpoints.test.ts',
    because: 'the checker — it necessarily names every string it bans',
  },
];

function collect(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collect(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function scannedFiles(): string[] {
  const excluded = new Set(DEFINING_ARTIFACTS.map((a) => path.resolve(EXT_ROOT, a.file)));
  return SCANNED_DIRS.flatMap((d) => collect(path.join(EXT_ROOT, d))).filter(
    (f) => !excluded.has(f),
  );
}

describe('no direct LLM endpoint in extension code (C-P4-5 AC-1)', () => {
  const files = scannedFiles();
  const sources = new Map(files.map((f) => [path.relative(EXT_ROOT, f), readFileSync(f, 'utf8')]));

  it('scans a non-trivial set of shipped files', () => {
    // A scan that matched nothing would pass every assertion below vacuously.
    expect(files.length).toBeGreaterThan(80);
    expect(sources.has('features/soql-nl-generate.ts')).toBe(true);
    expect(sources.has('features/ai-assistant.ts')).toBe(true);
  });

  it.each(PROVIDER_HOSTS)('names no model-provider host (%s)', (host) => {
    const offenders = [...sources.entries()]
      .filter(([, src]) => src.includes(host))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('holds no provider API key or key-shaped credential', () => {
    const offenders = [...sources.entries()]
      .filter(([, src]) => KEY_PATTERNS.some((re) => re.test(src)))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('keeps the AI features free of any fetch of their own', () => {
    // Both AI features must reach the outside world only through the bridge
    // client. Neither may call fetch/XHR/WebSocket/EventSource directly — the
    // bridge's own transport lives in lib/sfdt-bridge.ts and the Salesforce one
    // in the service worker.
    const AI_FEATURES = ['features/soql-nl-generate.ts', 'features/ai-assistant.ts'];
    const BANNED = [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /EventSource/];
    for (const file of AI_FEATURES) {
      const src = sources.get(file)!;
      for (const re of BANNED) {
        expect({ file, pattern: String(re), found: re.test(src) }).toEqual({
          file,
          pattern: String(re),
          found: false,
        });
      }
    }
  });

  it('routes the NL generator through the same bridge contract as the assistant', () => {
    // The positive half: it is not merely that there is no endpoint, it is that
    // the one call it does make is the contract's existing `ai` kind.
    const runner = sources.get('features/soql-runner.ts')!;
    expect(runner).toContain("kind: 'ai'");
    expect(runner).toContain('createBridgeClient');
    expect(sources.get('features/ai-assistant.ts')!).toContain("kind: 'ai'");
  });

  it('adds no host permission — the manifest still allows only Salesforce and localhost', () => {
    const config = readFileSync(path.join(EXT_ROOT, 'wxt.config.ts'), 'utf8');
    const block = /host_permissions:\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
    expect(block).not.toBe('');
    const hosts = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) {
      expect(host).toMatch(
        /^https:\/\/\*\.(salesforce\.com|salesforce-setup\.com|my\.salesforce\.com|lightning\.force\.com|my\.salesforce\.mil|lightning\.force\.mil|sfcrmapps\.cn|mcas\.ms)\/\*$|^http:\/\/(localhost|127\.0\.0\.1)\/\*$/,
      );
    }
  });
});
