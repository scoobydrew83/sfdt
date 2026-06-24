# Privacy Policy — SFDT SF Helper (`@sfdt/extension`)

**Last updated: 2026-05-17**

This Chrome extension is designed for Salesforce admins and developers. Its full source code is published in the public [`sfdt` repository on GitHub](https://github.com/scoobydrew83/sfdt) — you can verify every claim below against the code.

---

## TL;DR

- **No user data is sent to any third-party service from this extension.**
- **No analytics, telemetry, or usage tracking is sent off your device by default.** (Optional, opt-in, local-only telemetry exists — see "Telemetry" below.)
- **No advertising, no ad networks, no tracking pixels.**
- **No accounts. No sign-up. No PII collected.**
- All network traffic the extension makes is to:
  - The Salesforce org you're already authenticated with (Tooling API and standard REST endpoints) — same origin you're already on.
  - `http://127.0.0.1:7654` — only when you've started the local `sfdt ui` server yourself. Never leaves your machine.
  - A local Chrome native-messaging host (`com.sfdt.host`) — only when you've installed it via `sfdt extension install-host`. Never leaves your machine.

---

## Data the extension stores locally

All extension state lives in `chrome.storage.local` inside your Chrome profile. None of this is synced to other browsers or shared with us. None of it is transmitted off your device.

| Key | What it is | When it's written |
|---|---|---|
| `sfdt.settings` | Your per-feature toggles, AI provider preferences, bridge token | When you save the options page |
| `sfdt.killswitch.cache` | The most-recent server-disabled feature list from the local bridge ping | After every successful bridge ping |
| `sfdt.telemetry` | Opt-in local feature-use counters (see below) | Only when you've enabled telemetry |

You can clear all of it from `chrome://extensions` → SFDT SF Helper → Site data → Remove all.

---

## Telemetry (opt-in, local-only)

The extension does **not** collect or transmit telemetry unless you go to the options page and check "Enable local telemetry".

Even when enabled, all telemetry stays on your device:

- Counters are kept in `chrome.storage.local` under `sfdt.telemetry`.
- The schema is a per-feature `{ activated, errored, disabled_remote }` integer triple, keyed by feature id, plus a `monthKey` like `2026-05`.
- Counts roll over to zero at the start of each calendar month.
- Capped at 500 distinct feature ids.
- **No PII.** No org names, no usernames, no Flow names, no record ids, no IP, no timestamps beyond the month.
- **No outbound network requests.** The data is read back into the options page so *you* can see your own usage.

When you also have the local sfdt CLI running, the extension may push a snapshot of these counters to your machine's `<project>/.sfdt/telemetry-snapshot.json` so the CLI's `sfdt extension stats` command can render them. This file is local to your Salesforce project directory — it is not transmitted anywhere.

---

## Salesforce data

The extension reads Flow metadata via the Salesforce Tooling API using your existing Salesforce session. It does this from the page you're already on; no separate authentication is required and no Salesforce data ever leaves your browser via this extension.

The SOQL Query Runner, Org Limits, and REST API Explorer features call Salesforce REST and Tooling endpoints (`/services/data/...`) against the same session — queries, requests, and responses stay between your browser and the org you're already authenticated to.

When you use a feature that calls the local bridge (e.g. "Deploy this Flow"), the extension sends the Flow's developer name (e.g. `My_Flow`) to `http://127.0.0.1:7654` so the local sfdt CLI on your machine can run the deploy. The data goes from your browser to a process running on the same machine — it never leaves your device.

---

## Permissions

The extension manifest requests the following permissions. Each is used for the purpose listed; we do not use them for anything else.

| Permission | Why |
|---|---|
| `storage` | Save your per-feature toggles and (opt-in) local telemetry counters |
| `activeTab` | Run feature scripts on the Salesforce page you're currently viewing |
| `clipboardWrite` | The Flow Health Check feature copies the report to your clipboard on demand |
| `host_permissions: http://127.0.0.1/*` | Talk to the local sfdt CLI bridge running on your own machine |
| `host_permissions: *://*.salesforce.com/* / *.force.com/* / *.lightning.force.com/*` | Run feature scripts on Salesforce pages |
| `nativeMessaging` | Optional fallback transport to talk to the local sfdt CLI when the HTTP bridge isn't running. Only used if you install the native host. |

---

## Third parties

**None.** The extension does not bundle or call any third-party SDK, analytics service, error reporter, ad network, or telemetry endpoint.

The optional AI features (when enabled) send your prompts to a Claude / Gemini / OpenAI API key you supply — using your own account, billed to you, governed by that provider's privacy policy. The extension is a pass-through; we do not see, log, or store your prompts or completions.

---

## Children's privacy

This is a developer / admin productivity tool. It is not directed at children under 13 and does not knowingly collect any data from them.

---

## Changes to this policy

Changes will be announced in the repo's [CHANGELOG](../CHANGELOG.md) and in the Web Store listing.

---

## Contact

Open an issue at <https://github.com/scoobydrew83/sfdt/issues> with the `area: extension` label.
