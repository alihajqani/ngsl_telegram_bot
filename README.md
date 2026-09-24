# NGSL Telegram Bot

Persian/English vocabulary learning on Telegram: Leitner spaced repetition over the
NGSL 2,809-word list, with every word taught through real clips from a curated
corpus of TED / BBC / National Geographic talks.

Rebuilt from v1 around two changes that the old document model could not support:
a **corpus-first media pipeline** (ingest curated channels once, index every
sentence, serve by lookup) and a **relational core** that makes "never show the
same clip twice" a join rather than an impossibility.

## Layout

```
apps/bot          grammY long-polling process — handlers only, kept thin
apps/worker       BullMQ consumers: video render, scheduled jobs
packages/core     Pure domain — Leitner, progress, streaks. Zero I/O. Fully tested
packages/db       Drizzle schema, migrations, repositories
packages/media    Corpus ingest, segmentation, cutting and encoding clips
packages/shared   Zod-validated config, structured logging
services/aligner  Python sidecar: wav2vec2 forced alignment for clean cuts
```

The dependency direction is enforced by `eslint-plugin-boundaries`, not by
convention: `core` imports nothing, and no app may reach past a repository into
Drizzle. v1 had the same rule written in prose and broke it in 11 files.

## Getting started

### Docker (the whole stack)

```bash
cp .env.example .env          # fill in BOT_TOKEN, GEMINI_API_KEYS, POSTGRES_PASSWORD, REDIS_PASSWORD…
docker compose up -d --build  # postgres, redis, bot, worker, aligner
docker compose logs -f bot worker
```

`DATABASE_URL` and `REDIS_URL` are overridden by compose to the in-network
hostnames, so the values in `.env` only matter to commands run from the host.
On a database that has never been migrated, apply the schema and lexicon first:

```bash
docker compose up -d postgres
pnpm db:push && pnpm db:seed
```

### Local processes (for development)

```bash
pnpm install
docker compose up -d postgres redis
pnpm db:push                  # apply the schema
pnpm db:seed                  # load the 2,809-word NGSL list
pnpm dev:bot                  # and, in another shell: pnpm dev:worker
```

Requires Node 22+, pnpm 11, and `yt-dlp` + `ffmpeg` on PATH for the media pipeline.
The container images supply those two binaries themselves — and only to the
worker, since the bot never touches media. The aligner is optional: without it,
cuts fall back to subtitle timing snapped to the nearest pause.

### Images

`Dockerfile` builds both apps from one graph, as targets `bot` and `worker`.
They share every layer up to the TypeScript build and differ only at the end:
the worker adds ffmpeg and yt-dlp, the bot deliberately gets neither. Both run
as the unprivileged `node` user, and neither contains `.env` or any cookie jar —
secrets arrive at runtime through `env_file` and `/run/secrets/`.

Compose pins `name: ngsl_telegram_bot`. Volumes are namespaced by that project
name, so leaving it to be derived from the directory would strand the database
the moment the checkout is renamed.

## Commands

Release history and upgrade steps are in [CHANGELOG.md](CHANGELOG.md).

| Command | Purpose |
|---|---|
| `pnpm typecheck` | Build-mode type check across all packages |
| `pnpm test` | Vitest — domain logic in `packages/core` |
| `pnpm lint` | ESLint, type-aware, with layering rules |
| `pnpm db:generate` | Emit a migration from schema changes |
| `pnpm db:push` | Apply the schema directly (development) |
| `pnpm db:seed` | Seed `word` from `data/ngsl.csv`; idempotent. `--dry-run` validates the CSV only |
| `pnpm db:week-saturday` | One-off 2.1.0 upgrade: move stored leagues from Monday to Saturday weeks; idempotent |
| `pnpm ingest` | Ingest the corpus. `--list`, `--channel=<slug>`, `--limit=<n>`, `--delay=<ms>`, `--refresh` |
| `pnpm prewarm` | Queue video renders now. `--status` reports clip coverage, `--depth` targets the depth pool |
| `pnpm db:studio` | Browse the database |

## The corpus

`data/channels.yml` is the whitelist. Quality is enforced there, once, rather
than per search result — and only videos with **human-authored** English
subtitles are indexed. yt-dlp is invoked with `--write-subs` and deliberately
without `--write-auto-subs`, so a video carrying nothing but machine captions
produces no file and is recorded as `sub_status='none'`, never probed again.

Two measured facts shape the crawl:

- **Crawl oldest-first.** YouTube retired community-contributed captions in
  September 2020, so older uploads are far likelier to have real subtitles.
  Measured on the 6 newest vs 6 oldest uploads: TED went 3/6 → 6/6, and English
  Speeches went 0/6 → 6/6. `order: oldest` is the default for that reason.
- **Match `en.*`, not `en`.** BBC Learning English publishes `en-GB` and Vox
  publishes `en-US`; matching only `en` would silently discard both.

```bash
pnpm ingest --list                              # show the whitelist
pnpm ingest --channel=veritasium --limit=25     # smoke-test one channel
pnpm ingest --limit=500                         # every enabled channel
```

Subtitle cues are merged into sentence-shaped segments before indexing, so a
clip is a whole thought rather than the fragment a caption line happens to end
on. Each segment is then resolved against the closed NGSL vocabulary and written
to `word_occurrence` — a precomputed posting list, which is why serving a word
needs no search engine.

A channel's feed is read once and cached, and each video's raw subtitles are
stored, so repeat runs never page through YouTube again. Inside the containers,
run the CLIs through the worker, which has yt-dlp, ffmpeg and the cookies:

```bash
docker compose exec worker node packages/media/dist/cli.js --channel=ted --limit=25
docker compose exec worker node apps/worker/dist/prewarm-cli.js --status
```

## Clips

Rendering is one job per **source video**: download it once, find where every
sentence is really spoken (forced alignment in `services/aligner`), cut each
sentence locally with ffmpeg, and upload it once to the vault topic, whose
`file_id` is then reused forever. A clip belongs to a sentence, so it serves
every NGSL word in it. The only YouTube-facing step is the download, paced at
`RENDER_VIDEOS_PER_HOUR`; if YouTube shows its bot wall, every render pauses for
`BOT_WALL_PAUSE_MIN`. Details in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md) §8.

In the bot, clips play one at a time with ⏮/⏭, the word in bold, 👍/👎 and a link
to the moment on YouTube. Typing any English word or phrase searches them.

## Security

Configuration is parsed and validated **once**, at startup, by
`packages/shared/src/config.ts`. Reading `process.env` anywhere else is a lint
error.

YouTube cookies are mounted at runtime from `/run/secrets/`, never committed and
never `COPY`ed into an image — v1 leaked a live Google session by shipping
`data/cookies.txt` in both git and every Docker layer. Use a throwaway Google
account. Postgres and Redis bind to loopback only and both require a password.
