# syntax=docker/dockerfile:1.7

# Two images out of one graph, matching the `target:` keys in docker-compose.yml:
#
#   bot     — grammY long-polling. Interactive traffic only, so it carries no
#             media tooling at all: no ffmpeg, no yt-dlp, nothing to exploit.
#   worker  — BullMQ consumers. Adds ffmpeg + yt-dlp, which is the only reason
#             the two images differ.
#
# Everything up to `build` is shared, so the second target is nearly free.

ARG NODE_VERSION=22

# ── base ────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-bookworm-slim AS base
# pnpm 11 is pinned by the `packageManager` field; corepack honours it.
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

# ── dependencies ────────────────────────────────────────────────────────────
# Manifests before sources: editing a handler must not re-run `pnpm install`.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bot/package.json apps/bot/
COPY apps/worker/package.json apps/worker/
COPY packages/coach/package.json packages/coach/
COPY packages/content/package.json packages/content/
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/game/package.json packages/game/
COPY packages/llm/package.json packages/llm/
COPY packages/media/package.json packages/media/
COPY packages/monitor/package.json packages/monitor/
COPY packages/queue/package.json packages/queue/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
# `tsc -b` walks the project references, so every workspace package emits its
# own dist/ — including the seed and ingest CLIs, which is why the runtime image
# needs no tsx.
RUN pnpm build
# Prune devDependencies in place. dist/ is untouched; only node_modules shrinks.
# Switching to a prod install makes pnpm rebuild the modules directory, and it
# refuses to purge one without a TTY unless CI is set.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    CI=true pnpm install --frozen-lockfile --prod

# ── media tooling (worker only) ─────────────────────────────────────────────
# Branches off `base`, never off a stage carrying application code. ffmpeg pulls
# in ~180 packages, so if this layer sat downstream of the app it would be
# rebuilt — minutes of apt — every time a handler changed.
FROM base AS media-tools
# Debian's yt-dlp is far too old to survive YouTube's extractor churn, so take
# the upstream static build. Pin the tag when a reproducible image matters more
# than staying ahead of extractor breakage.
RUN --mount=type=cache,id=apt-cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,id=apt-lib,target=/var/lib/apt,sharing=locked \
    apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates curl \
 && curl -fsSL -o /usr/local/bin/yt-dlp \
      https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
 && chmod 0755 /usr/local/bin/yt-dlp \
 && yt-dlp --version \
 && apt-get purge -y curl && apt-get autoremove -y

# The payload lands last in each target, and is therefore repeated rather than
# shared: a common parent holding the app would drag the apt layer above back
# into every source-change rebuild. Two COPYs are the cheaper duplication.
#
# `data/` is excluded wholesale by .dockerignore because v1 shipped a live
# Google cookie jar inside it. The two corpus inputs are re-admitted there by
# name and copied explicitly — cookies still arrive only as a runtime mount.
# pnpm-workspace.yaml travels with the image, so workspaceRoot() resolves to
# /app and these land where the seed and ingest CLIs look for them.

# ── bot ─────────────────────────────────────────────────────────────────────
FROM base AS bot
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node data/ngsl.csv data/channels.yml ./data/
USER node
CMD ["node", "apps/bot/dist/index.js"]

# ── worker ──────────────────────────────────────────────────────────────────
FROM media-tools AS worker
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app /app
COPY --chown=node:node data/ngsl.csv data/channels.yml ./data/
# The clip scratch dir is a volume shared with the aligner. Creating it here,
# owned by node, makes a fresh volume inherit an owner the worker can write as.
RUN mkdir -p /tmp/ngsl-clips && chown node:node /tmp/ngsl-clips
USER node
CMD ["node", "apps/worker/dist/index.js"]
