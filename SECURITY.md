# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.2.x   | Yes       |
| < 0.2   | No        |

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

Out of scope: vulnerabilities in Salesforce orgs themselves, the `sf` CLI, or the Claude CLI — report those to their respective maintainers.
