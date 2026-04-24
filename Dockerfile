# ─────────────────────────────────────────────────────────────────────────────
# SFDT — Salesforce DevTools  Docker image
#
# Usage (run against a mounted Salesforce DX project):
#   docker build -t sfdt .
#   docker run --rm -v "$(pwd):/project" sfdt --help
#   docker run --rm -v "$(pwd):/project" sfdt deploy
#
# CI/CD example (GitHub Actions):
#   - uses: docker/build-push-action@v5
#     with:
#       context: .
#       tags: sfdt:latest
#
# Environment variables you can pass at run time:
#   GEMINI_API_KEY, OPENAI_API_KEY  — for non-Claude AI providers
#   SF_*                             — Salesforce CLI auth env vars
# ─────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Build the GUI ────────────────────────────────────────────────────
FROM node:20-slim AS gui-builder

WORKDIR /sfdt-gui

COPY gui/package.json gui/package-lock.json* ./
RUN npm ci

COPY gui/ ./
RUN npm run build

# ── Stage 2: Runtime image ────────────────────────────────────────────────────
FROM node:20-slim AS base

# ── System packages ───────────────────────────────────────────────────────────
# git:    required by manifest, changelog, review, pr-description commands
# bash:   required by shell scripts in scripts/
# jq:     required by several shell scripts for JSON parsing
# python3, make, g++: required to compile better-sqlite3 (native addon) if no
#          pre-built binary is available for the target Node/arch combination
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      bash \
      jq \
      curl \
      python3 \
      make \
      g++ \
    && rm -rf /var/lib/apt/lists/*

# ── Salesforce CLI ────────────────────────────────────────────────────────────
RUN npm install -g @salesforce/cli@latest --omit=dev

# ── sfdt ──────────────────────────────────────────────────────────────────────
WORKDIR /sfdt

# Copy only what's needed to install production dependencies
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy package source
COPY bin/     bin/
COPY src/     src/
COPY scripts/ scripts/

# Copy pre-built GUI from the builder stage
COPY --from=gui-builder /sfdt-gui/dist/ gui/dist/

# Make sfdt available globally inside the container
RUN npm link --legacy-peer-deps

# ── Runtime ───────────────────────────────────────────────────────────────────
# Mount your Salesforce DX project at /project
WORKDIR /project

ENTRYPOINT ["sfdt"]
CMD ["--help"]
