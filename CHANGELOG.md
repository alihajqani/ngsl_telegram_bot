# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release is tagged `vX.Y.Z` in git.

Behaviour is described in detail in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md); this
file says what changed and what an operator has to do about it.

## [Unreleased]

## [3.0.0] - 2026-09-24

### Changed

- **The clip pipeline is rebuilt around one download per source video.** A
  render job downloads the video once and cuts every clip it needs locally with
  ffmpeg. v2 re-extracted the same video from YouTube for every clip, which was
  the main trigger of YouTube's bot wall.
- **A clip is one sentence** (`segment_media`), shared by every NGSL word in it.
  v2 rendered and uploaded the same sentence once per word it contained.
- **Clean cuts.** A clip now runs from just before the sentence's first spoken
  word to just after its last, taken from forced alignment, or from subtitle
  timing snapped to the nearest pause when the aligner is not running. The fixed
  3-second lead-in is gone, and a sentence too long for a clip is skipped
  instead of cut off (v2 truncated anything over about 11 seconds).
- **Encoding for Telegram:** consistent loudness across all clips, click-free
  fades, `+faststart`, and upload metadata (streaming flag, size, duration,
  thumbnail) so playback starts at once.
- **Pre-warm renders whole videos**, chosen by how many under-covered words they
  help; a learner's waiting word is cut first.
- **Clips play one at a time**, YouGlish-style: ⏮/⏭ swap the video in place,
  the word is bolded, with 👍/👎 and a link to the moment on YouTube.

### Added

- **Search:** type any English word or phrase (or use 🔎 / `/search`) to see it
  in every rendered clip.
- **Forced-alignment service** (`services/aligner`, wav2vec2 on CPU).
- Channel feeds and raw subtitles are cached; `pnpm ingest --refresh` re-reads a
  feed early.
- A Redis **bot-wall circuit breaker** pauses every render for
  `BOT_WALL_PAUSE_MIN` when YouTube blocks.
- `pnpm prewarm --status` reports clip coverage per word.

### Fixed

- yt-dlp now gets `--js-runtimes node`; without it, the images (which ship Node,
  not Deno) could not solve YouTube's player challenges.
- A read-only cookie mount crashed every yt-dlp call when yt-dlp wrote the jar
  back; the worker now hands yt-dlp a private writable copy.
- YouTube's "session has been rate-limited" message is now recognised as the bot
  wall.

### Removed

- Tables `clip`, `user_clip_seen`, `clip_vote` (replaced by `segment_media`,
  `user_segment_seen`, `segment_vote`).
- Settings `CLIP_LEAD_SEC` and `PREWARM_RENDER_BUDGET` (see Upgrade notes).

### Upgrade notes

This release changes the corpus schema; migrations `0001`–`0003` drop the v2
clip tables, so **every rendered v2 clip is discarded** and must be re-rendered.

1. Apply the schema (`pnpm db:migrate`, or `pnpm db:push` in development), then
   run the ingest again: segments gain a `complete` flag and occurrences their
   surface forms at ingest time.
2. New settings, all with defaults: `CLIP_PAD_BEFORE_MS`, `CLIP_PAD_AFTER_MS`,
   `CLIP_MAX_HEIGHT`, `YTDLP_JS_RUNTIME`, `FFPROBE_BIN`, `ALIGN_MIN_SCORE`,
   `RENDER_VIDEOS_PER_HOUR`, `RENDER_MAX_CLIPS_PER_VIDEO`, `BOT_WALL_PAUSE_MIN`,
   `ENUMERATE_TTL_DAYS`. `CLIP_MAX_SEC` now defaults to 20.
3. For cookies, set `YOUTUBE_COOKIES_HOST_PATH` (the host file) as well as
   `YOUTUBE_COOKIES_FILE=/run/secrets/youtube_cookies.txt`.
4. `docker compose up -d --build` builds and starts the aligner too; its first
   build downloads CPU PyTorch and the model (about 1 GB).

## [2.2.0] - 2026-09-24

### Added

- **Every feature is on a button.** The main menu gains 🏆 League and 😴 Lazy
  Board, and admins get a 🛠 Admin button. Each board screen links to the other
  two, and the streak screen links to the Lazy Board.
- **One-tap off button** under the nightly boards message.
- **Cancel button** on the admin broadcast prompt.
- `/league` and `/lazy` in the published command menu, with Persian command
  descriptions for Persian-language clients.

### Changed

- The nightly boards message drops its "turn this off in settings" footer in
  favour of the button.

### Upgrade notes

No database or configuration change. A chat keeps the old reply keyboard until
the bot sends the menu again, which happens on `/start` or a language change.

## [2.1.0] - 2026-09-24

### Added

- **Nightly boards.** At 22:00 (app timezone) every learner gets one message
  with their league this week (top 10, their own rank, days left, and a
  closes-tonight warning on Friday), the all-time top 10 with their rank, and
  the opt-in Lazy Board. Skipped while nobody has earned points.
- **Settings toggle "🌙 Nightly boards"** to switch the message off. It uses the
  existing `digest_enabled` column (default on), so there is no schema change.
- **`pnpm db:week-saturday`**, a one-off, idempotent script that moves stored
  leagues from Monday weeks to Saturday weeks.

### Changed

- **League weeks run Saturday to Friday**, following the Iranian calendar.
  `weekStartKey` returns the Saturday, and the weekly rollover runs at Saturday
  00:00 instead of Monday 01:00.
- Worker bulk sends (reminders, motivation, nightly boards) share one dispatch
  module for sending, pacing and blocked-user flagging. Reminder behaviour is
  unchanged.

### Fixed

- A learner who studied after midnight but before the weekly rollover ran could
  end up in two leagues for the same week, and every later rollover carried both
  forward. The rollover now folds any other membership of that week into the one
  it assigns, points included.

### Upgrade notes

Run these in order. There is no schema migration.

1. Stop the bot and the worker: `docker compose stop bot worker`.
2. From the host, with `DATABASE_URL` in `.env` pointing at the database, run
   `pnpm db:week-saturday`. Leagues still keyed by a Monday are invisible to
   2.1.0: without this step the running week's learners are re-seeded into
   bronze and that week is never closed. Running it twice is harmless.
3. Rebuild and start: `docker compose up -d --build bot worker`. The scheduler
   updates the rollover's cron and registers `boards.nightly` on its own.

If the switch happens on a Saturday or Sunday, the running week lasts until the
following Saturday's rollover rather than closing early.

## [2.0.0] - 2026-08-14

### Added

- Rebuild of the bot around a corpus-first clip pipeline and a relational core:
  Leitner scheduling over the NGSL 2,809-word list, clips served from a curated
  TED / BBC / National Geographic corpus, the writing coach, points, streaks,
  weekly leagues, buddies, the Lazy Board, reminders, the admin panel, and the
  Telegram forum-topic monitor. See [README.md](README.md).
