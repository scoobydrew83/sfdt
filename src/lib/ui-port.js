// Default localhost port for `sfdt ui` / the GUI+bridge server.
// Single source of truth so `ui`, the gui-server, and `doctor` agree.
// There is no config/env override today — callers pass `--port` to change it.
export const DEFAULT_UI_PORT = 7654;
