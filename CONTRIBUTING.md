# Contributing to sfdt

Thank you for your interest in contributing to the Salesforce DevTools CLI! This project aims to provide a production-grade toolkit for Salesforce DX.

## Development Setup

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/sfdt-cli/sfdt.git
    cd sfdt
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    ```

3.  **Link for local development**:
    ```bash
    npm link
    ```
    This makes the `sfdt` command available globally, pointing to your local source code.

## Project Structure

- `bin/`: CLI entry point.
- `src/commands/`: Implementation of individual subcommands.
- `src/lib/`: Shared JavaScript logic (config, AI, script runner).
- `scripts/`: Shell scripts (bash) that handle heavy lifting (SFDX calls).
- `test/`: Vitest test suite.

## Guidelines

- **ESM Only**: This is a pure ESM project. Use `import`/`export`.
- **Shell Scripts**: 
  - Scripts must be non-interactive by default. Use `SFDT_NON_INTERACTIVE` check.
  - Use `set -euo pipefail` for robustness.
  - Rely on `SFDT_` environment variables passed from Node.js instead of parsing config files manually.
- **Node.js**: Target Node.js >= 20.0.0.
- **Testing**: Every new feature or bug fix must include tests.

## Coding Standards

- Run `npm run lint` before committing.
- Run `npm run format` to ensure consistent code style (Prettier).

## Submitting a Pull Request

1.  Create a feature branch from `main`.
2.  Make your changes and add tests.
3.  Ensure all tests pass: `npm test`.
4.  Open a PR with a clear description of the changes.

---
*By contributing, you agree that your contributions will be licensed under the MIT License.*
