// The flow-quality pipeline now lives in @sfdt/flow-core (browser-safe, shared by
// the CLI bridge, the GUI /api/flow/quality route, and the Chrome flow-quality
// tool) so every surface produces byte-identical scores. This module re-exports
// it to keep the established import path (`../flow-quality.js`) stable.
export {
  runFlowQuality,
  parseApiVersion,
  DEFAULT_RULES_CONFIG,
} from '@sfdt/flow-core';
