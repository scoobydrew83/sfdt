// @sfdt/plugin — Salesforce CLI (sf) plugin for SFDT.
// oclif discovers commands from ./dist/commands (see the `oclif` block in
// package.json); this entry just re-exports the shared forwarder.
export { forward } from './lib/forward.js';
