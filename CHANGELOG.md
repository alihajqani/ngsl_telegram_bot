# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/). Each release is tagged `vX.Y.Z` in git.

Behaviour is described in detail in [BUSINESS_LOGIC.md](BUSINESS_LOGIC.md); this
file says what changed and what an operator has to do about it.

## [Unreleased]

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
