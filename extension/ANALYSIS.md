# @sfdt Chrome Extension: Gap Analysis & Strategic Recommendations

This document provides an analysis of the requested strategic roadmap against the existing `@sfdt/extension` codebase, evaluating current capabilities, value propositions, and implementation recommendations for each proposed feature.

## Phase 1: Foundation & Local Bridge

### 1. Browser-to-CLI Model Context Protocol (MCP) Bridge
*   **Current State:** The extension has a robust custom RPC bridge (`packages/flow-core/src/bridge-contract.ts`) that talks to `sfdt ui` over HTTP or Native Messaging. This bridge currently supports specific commands (deploy, rollback, ping, ai, quality). The CLI also has an `sfdt mcp start` command (Phase 4 of CLI roadmap), but it is not linked to browser context.
*   **Value Assessment:** **Critical/High Value.** The current bridge is imperative (the extension commands the CLI). Shifting to MCP flips this, allowing the CLI (or any local agent) to query the extension for the active Salesforce browser context. This is the foundational piece for agentic development.
*   **Recommendation:** Extend `bridge-contract.ts` with new RPC kinds (e.g., `get-context`) or implement a local WebSocket server in the CLI that the extension connects to, streaming page state changes (URL, visible component metadata). The CLI's MCP server (`sfdt mcp`) should expose tools like `read_active_salesforce_page()` that fetch this state from the extension.

### 2. "Slop-Tracking" UI Overlay
*   **Current State:** We have `flow-health-check.ts` and `missing-description-flags.ts` for proactive governance, but no centralized "slop-tracking" API or database integration.
*   **Value Assessment:** **Medium/High Value.** Providing visual cues about technical debt *before* a developer interacts with code prevents the proliferation of bad patterns.
*   **Recommendation:** Implement `extension/features/slop-tracking.ts`. This requires adding a new `slop-query` kind to the bridge contract so the extension can ask the local CLI for the debt status of the currently viewed component.

## Phase 2: Workflow Acceleration & Agentic Support

### 3. Context-Window Optimized Exports
*   **Current State:** `comparison-exporter.ts` exports TSV. `metadata-retrieve.ts` uses standard Salesforce XML/zip formats. There is no LLM-optimized export.
*   **Value Assessment:** **High Value.** Copy-pasting from Salesforce UI yields messy text. Exporting standard XML burns tokens with boilerplate. Dense Markdown is the optimal format for LLMs.
*   **Recommendation:** Create `extension/features/export-for-prompt.ts`. It should inject a "Copy for Prompt" button into Object Manager (Fields) and Setup Code views (Apex, Flow). It will scrape the DOM or use the Tooling API to generate dense Markdown representations (e.g., `Field | Type | Required | Description`).

### 4. Headless Integration Simulator
*   **Current State:** `rest-explore.ts` and `soap-explore.ts` allow manual execution of API calls, but they don't simulate complex outbound integrations or intercept page requests for debugging.
*   **Value Assessment:** **Medium Value.** Highly useful for architects debugging complex webhook/auth flows, but might overlap with tools like Postman/Insomnia unless specifically tied to the active Salesforce session's context.
*   **Recommendation:** This would likely require declarativeNetRequest rules or an in-page script to intercept `fetch` calls, which is complex. A simpler first step might be a UI to generate mock payloads based on the current object schema to test external webhooks.

## Phase 3: Tactical Parity & Edge Case Management

### 5. Smart Test Array Scoping
*   **Current State:** The CLI's `sfdt deploy` supports test execution, but there is no UI in the extension to visually select or scope test arrays based on dependencies.
*   **Value Assessment:** **High Value.** Building the `--tests` array manually for targeted deployments is tedious and error-prone. A 1-click utility saves significant time.
*   **Recommendation:** Implement `extension/features/test-array-builder.ts`. In Apex Class views, it should use the Tooling API (via `salesforce-api.ts`) to query `SymbolTable` or `Metadata` dependencies, find related `@isTest` classes, and generate the CLI string.

### 6. Unified Session Handoff
*   **Current State:** The bridge uses a `bridge-token` for authorization, but relies on the local CLI's `sf` auth configuration to actually interact with Salesforce.
*   **Value Assessment:** **High Value (Quality of Life).** Removes the friction of ensuring the local CLI is authenticated to the same org being viewed in the browser.
*   **Recommendation:** Add a `session-handoff` kind to the bridge contract. The extension can extract the Session ID (via cookies or API) and send it to the CLI, which temporarily overrides its default connection for subsequent commands.

## Phase 4: Advanced Orchestration

### 7. SOQL to LangGraph Node Generator
*   **Current State:** `soql-runner.ts` successfully executes queries and formats tables/CSVs.
*   **Value Assessment:** **Medium Value.** Very niche for teams actively building LangGraph orchestrations, but serves as a powerful demonstration of the extension as a bridge to agentic tools.
*   **Recommendation:** Enhance `soql-runner.ts`. Add a "Export as LangGraph Node" button next to the CSV export. It will take the raw SOQL string, inspect the returned JSON schema (types of columns), and populate a string template containing the Python/TypeScript LangGraph boilerplate.
