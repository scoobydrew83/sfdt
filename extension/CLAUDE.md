# CLAUDE.md — @sfdt/extension (Chrome extension)

House rules for the SFDT Chrome extension. This is the extension-specific companion to the repo-root `CLAUDE.md` (which covers the `@sfdt/cli`). If you are working under `extension/`, follow this file **and** `extension/CONVENTIONS.md` (the numbered a11y/UI checklist).

## What this is

A Manifest V3 Chrome extension built with **WXT** + **TypeScript** (package `@sfdt/extension`). It injects developer tooling into Salesforce pages and ships a standalone Workspace app, an options page, and a toolbar popup. Build output lands in `.output/chrome-mv3/`.

## Layout

```
entrypoints/     content.ts (injected on SF pages), background.ts (service worker),
                 app/ (Workspace tab), options/ (settings page), popup/ (toolbar popup)
features/        one file per registry feature (soql-runner, inspect-record, apex-anonymous,
                 event-monitor, setup-tabs, flow-quality, …) — the injected tools
ui/              shared injected UI: side-button, present-view (page-mode overlays), toast,
                 modals, and the shadow-DOM host
lib/             tokens.ts (design tokens + dark palette), theme.ts (watchTheme/applyTheme),
                 settings.ts, salesforce-api.ts (thin client), sf-api-proxy.ts (worker fetch),
                 commands.ts, org-list.ts, api-version.ts
                 (sf-stream-worker.ts — worker CometD Port — lands with the P0-4 streaming migration)
test/            vitest (happy-dom), one suite per feature/lib module
wxt.config.ts    manifest (permissions, commands, host_permissions)
CONVENTIONS.md   the a11y/overlay/keyboard/theme/shadow-root checklist reviewers apply verbatim
```

## Non-negotiable rules

1. **DOM discipline — zero `innerHTML`.** Build DOM with `createElement` + `textContent` (+ `setAttribute`, `adoptedStyleSheets`/`<style>.textContent` for styles). This is a security-by-construction property and a marketed differentiator — never regress it. Use the shared `el()` helpers.

2. **The SID never leaves the background worker.** All Salesforce REST/Tooling/SOAP calls go through the worker's `sfApiFetch` route (`lib/sf-api-proxy.ts`); `lib/salesforce-api.ts` is a **thin client** that describes a call and parses the reply — it holds no sid and makes no Salesforce fetch. Feature/UI/entrypoint code MUST NOT touch `chrome.cookies`, `getSidForUrls`, `getSessionDetails`, or a raw `Authorization: Bearer` header — `test/sid-never-leaves-worker.test.ts` + a scoped ESLint rule enforce this. The event-monitor CometD stream is being moved into the worker behind an `sfApiStream` Port (`lib/sf-stream-worker.ts`) in the P0-4 streaming migration; **until that migration merges** it is the one documented, allowlisted exception in the guard test (event-monitor still calls `getSessionDetails`). Once it lands the guard allowlists nothing — don't add a new exception.

3. **Colours go through design tokens.** No hard-coded hex in `features/`, `ui/`, or `entrypoints/`. Use `var(--sfdt-color-*)` from `lib/tokens.ts`. **Foreground text** uses the foreground variants (`-text`, `-on-accent`, `-strong`); **fills/backgrounds/borders** use the base tokens (`brand`, `error`, `success`, `surface`, …). This split exists so dark mode is correct — a fill token used as `.style.color` renders wrong (low-contrast) in dark. `ensureTokens(document)` defines the `:root` token block (light + `[data-sfdt-theme="dark"]`) on the host document; custom properties inherit into shadow trees, so shadow-mounted UI just uses `var(--sfdt-*)`. `watchTheme()` boots the theme on every surface (returns `{ setSetting, stop }`; use `setSetting` for live preview).

4. **Feature-registry pattern.** A new capability is a registry feature (or an extension of one): a manifest with `contexts`/`permissions`/kill-switch id, and an opt-in toggle on the options page. Register it on the surfaces it belongs to (`content.ts` for SF pages, the Workspace app, etc.). New Chrome feature ⇒ also add it to `lib/feature-manifests.json` (parity-tested).

5. **Least-privilege permissions.** Do not add a manifest permission or host pattern without it being ledgered and human-reviewed; a permission change also updates `PRIVACY.md` + the store listing draft in the same PR.

6. **Package-internal paths via `import.meta.url`**, never `process.cwd()`.

7. **Telemetry is local-only.** No network egress; `test/telemetry.test.ts` enforces it.

## Testing & gates

Vitest per feature/lib (happy-dom); mock the message bus / `fetchImpl`. Every change must pass, from `extension/`:

```
npx vitest run
npx tsc --noEmit
npx eslint .
npx wxt build   # built manifest version must equal extension/package.json version
```

Injected-UI changes are also driven in a loaded unpacked build (`.output/chrome-mv3`) against a real org.

## A11y

Follow `CONVENTIONS.md`'s numbered checklist: Esc closes overlays, focus trap + restore, roles/labels on interactive elements, a full keyboard path, both themes, and shadow-root mounting for injected UI. `setup-tabs` and `flow-list-search` are the reference implementations.
