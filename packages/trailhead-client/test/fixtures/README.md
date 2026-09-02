# Recorded fixtures

Every file here is a verbatim response body from the **public**
`https://profile.api.trailhead.com/graphql` endpoint, recorded on 2026-09-02
with the exact documents in `src/queries.ts`. They are what makes the test
suite runnable with no network at all (`test/setup-no-network.ts` enforces it).

| File | Recorded from | Notes |
|------|---------------|-------|
| `profile-public.json` | `SfdtGetPublicProfile` on a public profile | Identity fields replaced (see below); certifications trimmed to three |
| `profile-private.json` | `SfdtGetPublicProfile` on a profile whose owner kept it private | The whole body — a `PrivateProfile` answers with `__typename` and nothing else |
| `profile-not-found.json` | `SfdtGetPublicProfile` on a slug that does not exist | GraphQL `errors` with `extensions.code: "NOT_FOUND"`, `data: null` |
| `earned-awards-page1.json` | `SfdtGetEarnedAwards` with `first: 3` | Shows a real opaque `endCursor` and `hasNextPage: true` |

## Why the public profile is anonymized

`profile-public.json` keeps the recorded **shape** — field names, nesting,
nullability, the non-padded `"2023-9-12"` date format, the real rank image
URL — but its `id`, `companyName` and `title` were replaced with synthetic
values before the file was committed. The shape is the only thing the tests
assert on, and a real Trailblazer's Salesforce user id does not need to live
in a public repo forever just to prove a normalizer works.

The award ids and cursors in `earned-awards-page1.json` are opaque
catalog/pagination identifiers, not personal ones, so they are left as
recorded.

## Refreshing them

Fixtures drift when the upstream schema does. `test/live.test.ts` is the
canary: it runs the same documents against the real endpoint and asserts the
recorded shape still holds. It is skipped unless you opt in:

```bash
SFDT_TRAILHEAD_LIVE=1 npm run test -w @sfdt/trailhead-client
```

If it fails, re-record by hand with `curl` (the documents are in
`src/queries.ts`), re-anonymize the identity fields above, and note the new
date in this file and in the header comment of `src/queries.ts`.
