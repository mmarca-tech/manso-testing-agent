# syntax=docker/dockerfile:1
#
# Manso runtime image.
#
# The implementation agent runs IN-PROCESS via @anthropic-ai/claude-agent-sdk /
# @openai/codex-sdk (no external CLI binary) — it only needs an LLM API key.
# But the SDK launches the Playwright MCP server (`npx @playwright/mcp`) and the
# target repo's verifyCommand is `npm run test:ui`, so the runtime needs Node +
# browsers. We therefore build on the Playwright base (browsers + OS deps
# preinstalled) pinned to the Playwright version the target repos use — this
# also makes the image M20-ready. git is added for branch/commit/push.
#
# Secrets are NEVER baked in — pass them at `docker run` time via --env-file/-e.

# Declared before the first FROM so it is usable in the runtime stage's FROM
# (an ARG declared inside a stage is not visible to a later FROM). Override with
# `--build-arg PLAYWRIGHT_VERSION=<x.y.z>` to match the target repos' Playwright.
ARG PLAYWRIGHT_VERSION=1.59.1

# ---- Builder: compile TypeScript to dist/, then prune to prod deps ----
FROM node:20-bookworm AS builder
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
# Re-resolve node_modules to production dependencies only (drops tsx/tsc/vitest).
RUN npm ci --omit=dev

# ---- Runtime: Playwright base (Node + browsers + OS deps) + git ----
ARG PLAYWRIGHT_VERSION=1.59.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy AS runtime
ENV NODE_ENV=production
# git is already present in the Playwright base image (used for branch/commit/
# push), so no apt-get is needed — which also avoids depending on the Ubuntu
# archive being reachable behind a proxy at build time.
WORKDIR /app/manso
COPY --from=builder /build/node_modules ./node_modules
COPY --from=builder /build/dist ./dist
COPY package.json ./
COPY skills ./skills
# `docker run <image> <verb> [flags]` → manso CLI.
ENTRYPOINT ["node", "/app/manso/dist/cli/main.js"]
CMD ["--help"]
