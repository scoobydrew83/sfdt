#!/usr/bin/env bash
#
# sfdt installer — bootstraps @sfdt/cli via npm after verifying prerequisites.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/scoobydrew83/sfdt/main/install.sh | bash
#   ./install.sh            # from a checkout
#
# This script does NOT use sudo. If your npm global prefix is not writable it
# prints guidance instead of escalating privileges.

set -euo pipefail

PKG="@sfdt/cli"
MIN_NODE_MAJOR=22
MIN_NODE_MINOR=15

# ── Pretty output ─────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m')
  YELLOW=$(printf '\033[33m'); RESET=$(printf '\033[0m')
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi
info()  { printf '%s\n' "$*"; }
ok()    { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn()  { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
fail()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; }

have()  { command -v "$1" >/dev/null 2>&1; }

MISSING=0
require() {
  # require <cmd> <human-name> <install-hint>
  if have "$1"; then
    ok "$2 found ($(command -v "$1"))"
  else
    fail "$2 is required but not found."
    info "    Install: $3"
    MISSING=1
  fi
}

printf '%ssfdt installer%s\n\n' "$BOLD" "$RESET"

# ── Node.js (>= 22.15.0) ──────────────────────────────────────────────────────
if have node; then
  NODE_VER=$(node -p 'process.versions.node')
  NODE_MAJOR=${NODE_VER%%.*}
  NODE_REST=${NODE_VER#*.}
  NODE_MINOR=${NODE_REST%%.*}
  if [ "$NODE_MAJOR" -gt "$MIN_NODE_MAJOR" ] || { [ "$NODE_MAJOR" -eq "$MIN_NODE_MAJOR" ] && [ "$NODE_MINOR" -ge "$MIN_NODE_MINOR" ]; }; then
    ok "Node.js $NODE_VER (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR})"
  else
    fail "Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ required, found $NODE_VER."
    info "    Upgrade via https://nodejs.org or your version manager (nvm/fnm)."
    MISSING=1
  fi
else
  fail "Node.js is required but not found."
  info "    Install Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}+ from https://nodejs.org"
  MISSING=1
fi

# ── npm ───────────────────────────────────────────────────────────────────────
require npm "npm" "ships with Node.js — reinstall Node if missing"

# ── Runtime prerequisites ─────────────────────────────────────────────────────
require sf "Salesforce CLI (sf)" "npm install -g @salesforce/cli"
require jq "jq" "brew install jq   (macOS)  |  apt-get install jq   (Debian/Ubuntu)"

# bash 4+ is needed by some shell scripts; macOS ships 3.2 by default. Probe the
# `bash` on PATH (the one the project's scripts run under), not necessarily the
# shell running this installer — a single subprocess returns major + full version.
if have bash; then
  BASH_PROBE=$(bash -c 'printf "%s %s" "${BASH_VERSINFO[0]:-0}" "$BASH_VERSION"')
  BASH_MAJOR=${BASH_PROBE%% *}
  BASH_FULL=${BASH_PROBE#* }
  if [ "${BASH_MAJOR:-0}" -ge 4 ]; then
    ok "bash ${BASH_FULL} (>= 4)"
  else
    warn "bash 4.0+ recommended (found ${BASH_FULL:-unknown}). macOS: brew install bash"
  fi
fi

# ── gh (optional) ─────────────────────────────────────────────────────────────
if have gh; then
  ok "GitHub CLI (gh) found (optional — used for PR creation)"
else
  warn "GitHub CLI (gh) not found (optional — only needed for PR-creating commands)."
fi

if [ "$MISSING" -ne 0 ]; then
  printf '\n%sMissing required prerequisites — resolve the items above and re-run.%s\n' "$RED" "$RESET" >&2
  exit 1
fi

# ── Writable global prefix check ──────────────────────────────────────────────
PREFIX=$(npm config get prefix 2>/dev/null || echo "")
if [ -n "$PREFIX" ] && [ ! -w "$PREFIX" ]; then
  warn "npm global prefix ($PREFIX) is not writable by your user."
  info "    Avoid sudo. Either:"
  info "      - set a user-owned prefix:  npm config set prefix \"\$HOME/.npm-global\""
  info "        and add \"\$HOME/.npm-global/bin\" to your PATH, then re-run; or"
  info "      - use a Node version manager (nvm/fnm) that owns its prefix."
fi

printf '\n%sInstalling %s ...%s\n' "$BOLD" "$PKG" "$RESET"
npm install -g "$PKG"

printf '\n'
ok "$PKG installed."
info ""
info "Next steps:"
info "  1. cd into your Salesforce DX project"
info "  2. sfdt init        # create .sfdt/config.json"
info "  3. sfdt --help      # explore commands"
