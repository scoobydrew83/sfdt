# @sfdt/web

Edge-hosted Next.js 15 App Router app. **WEB-1 scaffold** — design tokens and empty chrome. No linter, no D1, no PKCE.

## Runtime split

| Surface | Runtime | Data |
|---|---|---|
| Leaderboard, profiles, banners, shields | Cloudflare Edge | Public Trailhead + D1/R2 cache (WEB-3+) |
| Flow Studio, Security, Field Impact | Browser + Web Worker | User XML or Tooling/REST via PKCE. Tokens in memory / `sessionStorage` only |

Org metadata, Flow XML, PermissionSet rows, and PKCE tokens are **never** written to Cloudflare.

## Home

This package is an npm workspace at `web/` in `scoobydrew83/sfdt`. It is **not** `sfdt-site` (that repo stays static docs). Do not convert the monorepo to pnpm or Turborepo from this package.

## Commands

```bash
npm run dev -w @sfdt/web          # Next dev server
npm run typecheck -w @sfdt/web
npm test -w @sfdt/web
npm run preview -w @sfdt/web      # OpenNext + wrangler dev
```

`wrangler dev` needs a prior `opennextjs-cloudflare build`. Local UI work uses `next dev`.

## Engine

`GET /api/engine` returns `{ engine, version }` from `@sfdt/flow-core`. The worker in WEB-6 calls `runFlowQuality` — do not invent `FlowParser.fromXML`.

## Routes in this scaffold

- `/` — hub + fixture leaderboard teaser
- `/trailblazers`, `/trailblazers/[handle]`
- `/tools/flow-linter` — Flow Studio chrome (no worker)
- `/tools/security-audit`, `/tools/field-impact` — copy-only stubs
