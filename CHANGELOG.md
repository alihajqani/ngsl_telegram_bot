# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release is tagged `vX.Y.Z` in git.

Behaviour is described in detail in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md); this
file says what changed and what an operator has to do about it.

## [Unreleased]

### Added

- **`scripts/deploy.sh`** deploys the pushed `main` to the server: preflight
  checks on both sides, image build here, resumable transfer of only the
  images that changed, `git pull`, migrations before the restart, restart, and
  a health check. Documented in README → "Deploy to the server".
- **`migrate.js --baseline`** records every migration as applied on a database
  built with `drizzle-kit push` whose schema is current, so later migrations
  apply automatically. Refused on a database that already has a journal.

### Changed

- **Writing practice takes words from every box**, the first boxes favoured,
  instead of only box 4 and 5 (box 3 as a fallback). Each word slot draws a box
  first (weights 5, 4, 3, 2, 1 for boxes 1 to 5), then a word inside it, so a
  full box 5 cannot crowd out the words still being learned. A learner needs 3
  words in their deck, not 3 mastered ones; before, most learners were told
  they had no words to write with.

## [3.3.0] - 2026-09-25

### Added

- **Update announcement.** When the worker starts on a new version, every
  learner gets one message, in their language, with the version number and a
  tap-able /start. It is paced at five messages a second, resumes where it
  stopped if the worker restarts, and is never sent twice for a version.
  `ENABLE_RELEASE_ANNOUNCEMENT=false` turns it off.
- **Two channels:** The Obama White House archive (`obama-white-house`, 2009
  speeches with human-written subtitles) and Barack Obama (`barack-obama`, as
  asked; measured 0 of 12 videos with human subtitles, so expect little from
  it).

### Fixed

- **A word's clips could all come from one video** ("both": six clips, one
  talk). Coverage counted clips, so a talk saying a word six times looked like
  good coverage and no other video was planned for it. Coverage now counts
  distinct videos that an American-setting learner is served, British channels
  are planned last, and opening a word's clips queues more videos when it has
  too few.
- The accent ordering added in 3.2.0 put all of a word's American clips ahead
  of the rest, so a single American talk played through before any other
  video. Decks again show one clip per video per round, with the learner's
  accent first within each round. Searches now alternate videos too.
- A bulk send that hit Telegram's flood control (429) was dropped; it now
  waits `retry_after` and tries once more.

### Changed

- `PREWARM_BREADTH_TARGET` and `PREWARM_DEPTH_TARGET` now count videos per
  word, not clips (defaults unchanged, 10 and 30). More words fall below
  target right after the upgrade, so the sweeps will render more videos for a
  while, still paced by `RENDER_VIDEOS_PER_HOUR`.

### Upgrade notes

- No schema change.
- Ingest the new channels once:
  `docker compose exec worker node packages/media/dist/cli.js --channel=obama-white-house --limit=50`
  (and `--channel=barack-obama` if wanted).

## [3.2.0] - 2026-09-25

### Added

- **Clip accent setting.** ⚙️ Settings has a 🗣 button that cycles through
  🇺🇸 American, 🇬🇧 British and 🌐 All. American is the default, including for
  existing users. American or British serves that accent's channels first, then
  the mixed ones (TED, Veritasium, English Speeches), and never the other
  accent. The choice applies to word clips and to search. When a word has clips
  only in another accent, the bot says so instead of "being prepared".

### Changed

- **New words come one at a time.** Each card has a numbered ⏭ Next word
  button, so a batch of twenty is no longer twenty messages at once. A word is
  added to the deck when its card is shown, so stopping halfway keeps the rest
  of the day's allowance. Points are recorded per card and announced with the
  last one.
- The ingest now refreshes `channel.accent` from `data/channels.yml` on every
  run, not only when the channel is first seen.

### Fixed

- **🏆 League showed nothing.** Opening a board from the menu or by command
  threw before replying (`answerCallbackQuery` on a message). The all-time and
  Lazy boards had the same fault.
- **The menu could not be closed with the back button on a phone.** The main
  menu is no longer persistent; the keyboard icon next to the input field
  opens it again.

### Upgrade notes

- Migration `0004_clip_accent` adds `user_settings.clip_accent`. Apply it before
  starting the new bot: `docker compose run --rm --no-deps -T worker node
  packages/db/dist/migrate.js`.
- Telegram keeps the menu a chat last received, so each learner gets the
  closable menu after their next `/start`.

## [3.1.0] - 2026-09-25

### Added

- **`scripts/local-up.sh`** brings the whole stack up on one machine with only
  Docker installed: preflight checks of `.env` and the cookie file, image
  builds, Postgres and Redis, schema, the NGSL seed, then the aligner, worker
  and bot, with a summary at the end. Options: `--check`, `--no-build`,
  `--no-bot`, `--no-aligner`, `--ingest=N`, `--content`, `--reset`. Documented
  in README → "Run it locally".
- **`packages/db/dist/migrate.js`** applies pending migrations from inside the
  app images, where `drizzle-kit` is not installed. A database created with
  `drizzle-kit push` (no migration journal) is detected and left untouched.

## [3.0.2] - 2026-09-24

### Fixed

- **Alignment was lost on a small server.** The worker sent a whole talk to
  the aligner in one request, and the aligner answers only when done. On one
  CPU core that took longer than the five minutes Node's fetch waits for
  response headers, so every alignment was dropped and every cut fell back to
  subtitle timing. Sentences now go in batches of 25, and only the sentences
  about to be cut plus their neighbours are aligned, not the whole talk. If a
  later batch fails, the batches already answered are kept.
- Gemini's momentary `500` errors are retried twice (after 2 s and 6 s); in one
  full content run they caused nine of ten failed batches.
- A content batch the model returns as a bare array instead of
  `{"words": [...]}` is accepted instead of failing.

## [3.0.1] - 2026-09-24

### Fixed

- **No collocations or LLM examples were ever saved with a thinking model.**
  Gemma 4 and Gemini 2.5 return their reasoning as separate `thought` parts,
  and the provider joined those into the answer. The reasoning drafts the JSON
  with `"..."` placeholders, so that draft was parsed instead of the answer and
  every word was dropped, while the run reported no failure. Thought parts are
  now discarded, and the default output budget is 8,192 tokens so the reasoning
  cannot crowd out the answer. The writing coach uses the same path and is
  fixed too.
- A content batch that parses but matches none of the requested words is now
  logged as a warning instead of passing silently.
- The aligner image no longer stores the model weights twice (2.57 GB → 1.96 GB).

### Upgrade notes

Run `content all` once so every word gets its examples and collocations:
`docker compose exec worker node packages/content/dist/cli.js all`. It resumes
where it left off if interrupted.

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
