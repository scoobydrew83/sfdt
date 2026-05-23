# Chrome Web Store Auto-Publish Setup

This guide explains how to wire `.github/workflows/extension.yml` to auto-publish new versions of `@sfdt/extension` to the Chrome Web Store every time the extension's `package.json` version is bumped and merged to `main`.

It is a **one-time setup**. Once complete, every `extension/package.json` version bump in a merge to `main` triggers:

1. Build the chrome-mv3 zip via `wxt zip`
2. Create the `ext-vX.Y.Z` git tag
3. Create a GitHub Release with the zip attached
4. Upload the zip to the Chrome Web Store as a new version
5. Auto-publish to users (or queue for review, depending on your CWS item settings)

Do not run this setup until the initial submission (`v0.0.1`) has been approved by Google. The `CWS_EXTENSION_ID` is assigned by Google on first approval.

---

## Prerequisites

- The extension is already submitted to and approved by the Chrome Web Store.
- The `extension-release` GitHub environment exists in the repo (already created — `extension.yml` references it).
- You have admin access to the Google account that owns the Chrome Web Store publisher profile.
- You have admin access to the repo (to add environment secrets).

---

## Step 1 — Capture the Extension ID

Open the Chrome Web Store Developer Dashboard:

```
https://chrome.google.com/webstore/devconsole
```

Click into the **SFDT SF Helper** item. On the **Package** tab (or in the URL — `https://chrome.google.com/webstore/devconsole/<publisher-id>/<extension-id>/...`), copy the **Item ID** — a 32-character lowercase string like `abcdefghijklmnopqrstuvwxyz123456`.

Save this as `CWS_EXTENSION_ID`.

---

## Step 2 — Enable the Chrome Web Store API

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or pick an existing one) — name it something like `sfdt-cws-publish`.
3. **APIs & Services → Library** → search `Chrome Web Store API` → click **Enable**.

---

## Step 3 — Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type:
   - **Internal** if your Google account is part of a Google Workspace org.
   - **External** otherwise — and add your own Google account as a Test User in step 5 of the consent-screen flow.
3. Fill the basics:
   - App name: `SFDT CWS Publisher`
   - User support email: your address
   - Developer contact email: your address
4. Scopes — add the single scope: `https://www.googleapis.com/auth/chromewebstore`.
5. Save and continue through the rest. You do not need to publish the app — Testing mode is fine since only you will use it.

---

## Step 4 — Create the OAuth 2.0 client

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Desktop app**.
3. Name: `sfdt-cws-publisher-cli`.
4. Click **Create**.
5. A modal shows the **Client ID** and **Client Secret**. Copy both.

Save these as `CWS_CLIENT_ID` and `CWS_CLIENT_SECRET`.

---

## Step 5 — Generate a refresh token (one-time OAuth dance)

The CI job needs a long-lived refresh token to call the CWS API non-interactively. Generate it once locally.

### 5a. Get an authorization code

Open this URL in a browser (replace `CLIENT_ID`):

```
https://accounts.google.com/o/oauth2/auth?response_type=code&scope=https%3A//www.googleapis.com/auth/chromewebstore&client_id=CLIENT_ID&redirect_uri=urn:ietf:wg:oauth:2.0:oob&access_type=offline&prompt=consent
```

Sign in with the same Google account that owns your CWS publisher profile, approve the scope, and Google shows you a one-time **authorization code**. Copy it.

> The `prompt=consent` parameter is important — it forces Google to return a refresh token even if you've authorized this client before.

### 5b. Exchange the code for a refresh token

In a terminal, run:

```bash
curl -s "https://accounts.google.com/o/oauth2/token" \
  -d "client_id=CLIENT_ID" \
  -d "client_secret=CLIENT_SECRET" \
  -d "code=AUTH_CODE_FROM_STEP_5A" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=urn:ietf:wg:oauth:2.0:oob"
```

The JSON response contains a `refresh_token` field. Copy that value.

Save this as `CWS_REFRESH_TOKEN`.

The authorization code is one-time-use. If you mess up, re-run step 5a to get a fresh code.

---

## Step 6 — Add the four secrets to the GitHub environment

Repo → Settings → Environments → `extension-release` → Add secret. Add each of:

- `CWS_EXTENSION_ID`
- `CWS_CLIENT_ID`
- `CWS_CLIENT_SECRET`
- `CWS_REFRESH_TOKEN`

Use the environment-scoped secrets (not repo-wide), so only the `release` job in `extension.yml` can read them.

---

## Step 7 — Enable the publish step in extension.yml

Open `.github/workflows/extension.yml`. Find the commented block at the bottom of the `release` job (search for `Publish to Chrome Web Store`). Remove the leading `#` from each of those lines so it looks like:

```yaml
      - name: Publish to Chrome Web Store
        if: steps.version.outputs.changed == 'true'
        env:
          CWS_CLIENT_ID: ${{ secrets.CWS_CLIENT_ID }}
          CWS_CLIENT_SECRET: ${{ secrets.CWS_CLIENT_SECRET }}
          CWS_REFRESH_TOKEN: ${{ secrets.CWS_REFRESH_TOKEN }}
          CWS_EXTENSION_ID: ${{ secrets.CWS_EXTENSION_ID }}
        run: |
          CHROME_ZIP=$(ls extension/.output/*-chrome.zip | head -1)
          npx chrome-webstore-upload-cli@3 upload \
            --source "${CHROME_ZIP}" \
            --extension-id "${CWS_EXTENSION_ID}" \
            --client-id "${CWS_CLIENT_ID}" \
            --client-secret "${CWS_CLIENT_SECRET}" \
            --refresh-token "${CWS_REFRESH_TOKEN}" \
            --auto-publish
```

Commit the uncommented file on a feature branch, open a PR to `develop`, then merge `develop` to `main` when ready. Do not test the publish step on `develop` — it only runs on pushes to `main`.

---

## Step 8 — Smoke-test the pipeline

1. Bump `extension/package.json` from `0.0.1` to `0.0.2` (a one-character version bump that won't change behavior).
2. Commit to `develop` → PR → merge into `main`.
3. Watch the run in the Actions tab. The `release` job → `Publish to Chrome Web Store` step should succeed in 10–20 seconds.
4. Open the Chrome Web Store dashboard. The item version should now read `0.0.2` and the status should be either **Published** (if auto-publish review went through) or **Pending review** (if Google chose to re-review — common on the first auto-publish after major permission changes).

---

## How releases work after this setup

Day-to-day, releasing a new extension version is just:

```bash
# In a feature branch:
cd extension
# bump version in package.json
npm version patch   # 0.0.2 → 0.0.3
cd ..
git add extension/package.json
git commit -m "chore(extension): release 0.0.3"
# PR develop → main, merge
```

That's it. Everything else is automated.

---

## Re-publish flag behavior

`--auto-publish` tells the CWS API: "after upload, immediately submit for publication". The Chrome Web Store decides whether to:

- **Auto-publish without review** — for trivial version bumps with no permission / scope / description changes
- **Re-review then publish** — for any version that changes the manifest in a material way (new permissions, new host patterns, large description change)

There is nothing you can do to force the first path. If you want full control over when a reviewed version reaches users, drop `--auto-publish` and switch your CWS item to "Publish manually" in the Distribution tab — the workflow will then upload and queue, and you click **Publish** in the dashboard whenever you're ready.

---

## Maintenance

- **Refresh token expiry** — the refresh token does not expire unless Google revokes it (rare). If you ever see `invalid_grant` errors in CI, re-run step 5 to regenerate.
- **OAuth client expiry** — desktop OAuth clients in Testing mode require the developer to re-approve every 6 months. If your consent screen is set to External + Testing, set a calendar reminder. The fix is to re-run step 5.
- **Rotating the secret** — if `CWS_REFRESH_TOKEN` or `CWS_CLIENT_SECRET` ever leaks, revoke the OAuth client in Google Cloud Console and run steps 4–6 again. The Extension ID never changes.

---

## Troubleshooting

| Error | Fix |
|---|---|
| `invalid_grant` | Refresh token expired or revoked → regenerate via step 5 |
| `Item not found` | `CWS_EXTENSION_ID` doesn't match an item under this publisher account → check the ID and the Google account that authorized the OAuth client |
| `Cannot publish item: requires payment of one-time developer registration fee` | The Google account you authorized OAuth with hasn't paid the one-time $5 CWS developer fee → pay it in the dashboard |
| `403 Forbidden` from upload step | The OAuth scope is wrong → ensure it is exactly `https://www.googleapis.com/auth/chromewebstore` (no trailing slash) |
| `Package is invalid: 'manifest'` | The zip doesn't contain a top-level manifest.json → check `wxt zip` output; ensure `extension/.output/*-chrome.zip` exists |
| Workflow says "no version change" | `extension/package.json` version was not bumped, or was bumped on a branch other than `main`; the `release` job is gated on `git show HEAD~1:extension/package.json` showing a different version on the merge commit |
