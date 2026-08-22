# Security Policy

## Supported Versions

| Version  | Supported |
| -------- | --------- |
| 0.22.x   | Yes       |
| < 0.22   | No        |

Only the latest minor line receives security fixes. See [docs/versioning.md](docs/versioning.md)
for the support window and how it changes at 1.0.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities privately using [GitHub's private security advisory feature](https://github.com/scoobydrew83/sfdt/security/advisories/new).

Include as much detail as possible:

- A description of the vulnerability and its potential impact
- Steps to reproduce or a proof-of-concept
- Affected versions
- Any suggested mitigations (optional)

### What to expect

- **Acknowledgement** within a few days
- **Status update** within 2–3 weeks (confirmed, in progress, or not applicable)
- **Fix and disclosure** coordinated with you before any public announcement

We follow [responsible disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure) — we will credit reporters in the release notes unless you prefer to remain anonymous.

## Scope

This CLI tool runs locally on developer machines with the user's own Salesforce credentials. The primary attack surface is:

- **Shell script injection** via malformed config values or environment variables
- **Dependency vulnerabilities** in bundled npm packages
- **Credential exposure** through log output or error messages

### How this tool handles Salesforce credentials

sfdt **stores no Salesforce tokens**. Authentication is ambient: commands shell out to the `sf`
CLI, which joins the session itself from its own keychain, so in almost every code path no token
ever enters this process.

There is one deliberate exception, and it is worth stating plainly. `sfdt events tail` opens a
CometD long-poll — a single HTTP connection this process must hold open for minutes — and `sf`
has no subcommand that can proxy one. So that command reads an access token via
`sf org display` and holds it **in memory for the life of the command**.

The constraints on it:

- Read from the `sf` keychain at the moment of use. Nothing is written, cached to disk, or
  persisted between runs, so no new secret is stored anywhere.
- Never logged, never placed in the JSON envelope, never written to a snapshot or a notification
  payload.
- Never accepted from a command-line flag or an environment variable — it comes from the keychain
  or it does not come at all.
- `accessToken`, `sessionId` and `sid` are in the redaction list applied to log output, so
  anything that does reach a log is masked. That is a backstop, not the mechanism.

All of it lives in one file — `src/lib/org-session.js` — so reviewing this behaviour means
reading one file rather than searching the tree.

Out of scope: vulnerabilities in Salesforce orgs themselves, the `sf` CLI, or the Claude CLI — report those to their respective maintainers.
