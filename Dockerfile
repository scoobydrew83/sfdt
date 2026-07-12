# ─────────────────────────────────────────────────────────────────────────────
# SFDT — Salesforce DevTools  Docker image
#
# Built from the PUBLISHED @sfdt/cli npm package (not the monorepo source), so the
# image matches exactly what `npm install -g @sfdt/cli` gives users — including the
# bundled gui/dist and the @sfdt/flow-core dependency resolved from npm. (Building
# from the monorepo source doesn't work in isolation: flow-core is a workspace
# link, not a copied package.)
#
# Usage (run against a mounted Salesforce DX project):
#   docker run --rm -v "$(pwd):/project" ghcr.io/scoobydrew83/sfdt --help
#   docker run --rm -v "$(pwd):/project" ghcr.io/scoobydrew83/sfdt deploy
#   docker run --rm -v "$(pwd):/project" ghcr.io/scoobydrew83/sfdt ci init --provider gitlab --type release --print
#
# This image also serves as a CI job image: `sfdt ci init --runner docker`
# generates GitLab/Bitbucket pipelines that run on it directly (sf CLI and
# sfdt preinstalled — no per-run npm installs).
#
# Build a specific version locally:
#   docker build --build-arg VERSION=0.14.0 -t sfdt .
#
# Run-time env vars:
#   OPENROUTER_API_KEY / OPENAI_API_KEY / …  — for the http AI provider
#   SF_* or SFDX_AUTH_URL                     — Salesforce CLI auth
# ─────────────────────────────────────────────────────────────────────────────

# Node 22 is required (>= 22.15 for the built-in node:sqlite used by the pull cache).
FROM node:22-slim

# ── System packages ───────────────────────────────────────────────────────────
# git: manifest/changelog/review/pr-description commands · bash: scripts/ ·
# jq: JSON parsing in shell scripts · curl: misc.
# (No native-addon toolchain needed — sfdt uses Node's built-in node:sqlite.)
RUN apt-get update && apt-get install -y --no-install-recommends \
      git bash jq curl \
    && rm -rf /var/lib/apt/lists/*

# ── Salesforce CLI ────────────────────────────────────────────────────────────
RUN npm install -g @salesforce/cli@latest --omit=dev

# ── sfdt CLI (from npm) ────────────────────────────────────────────────────────
# VERSION defaults to the latest published release; the docker-publish workflow
# pins it to the released version via --build-arg.
ARG VERSION=latest
RUN npm install -g "@sfdt/cli@${VERSION}"

# ── Runtime ───────────────────────────────────────────────────────────────────
# Mount your Salesforce DX project at /project.
WORKDIR /project

ENTRYPOINT ["sfdt"]
CMD ["--help"]
