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

FROM node:20-slim AS base

# ── System packages ───────────────────────────────────────────────────────────
# git: required by manifest, changelog, review, pr-description commands
# bash: required by shell scripts in scripts/
# jq:  required by several shell scripts for JSON parsing
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      bash \
      jq \
      curl \
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
COPY gui/dist/ gui/dist/

# Make sfdt available globally inside the container
RUN npm link --legacy-peer-deps

# ── Runtime ───────────────────────────────────────────────────────────────────
# Mount your Salesforce DX project at /project
WORKDIR /project

ENTRYPOINT ["sfdt"]
CMD ["--help"]
