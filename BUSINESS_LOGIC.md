# Business Logic

> **This document is extracted from the code, and it is only true of the code.**
> Every rule, threshold and constant below was read out of the files cited beside
> it, not from a design doc or a plan.
>
> **Whenever you change behaviour, update this file in the same change.** A rule
> here that no longer matches its cited file is a bug in this document. Each
> section names the files it was derived from, so the blast radius of a code
> change is directly greppable: touch `packages/core/src/streak.ts`, re-read
> §7 here. Add an entry to the Changelog below every time.

**Extracted from commit:** `bfb3958`
**Last verified:** 2026-09-25

---

## Changelog

Newest first. Record the commit whose behaviour the document now describes, not
the commit that edited the document.

### 2026-09-25 — describes `v3.3.0`

- Coverage is counted in distinct videos a default (American) learner is
  served, not clips; the planner puts British channels last; opening a word's
  deck pre-warms it (§8.5).
- Decks go one clip per video per round, and the accent preference only orders
  clips within a round; searches round-robin by video too (§8.6).
- After a deploy of a new version the worker tells every learner once, paced
  and resumable; bulk sends wait out a 429 (§13).
- Channels `obama-white-house` and `barack-obama` join the whitelist (§8.2).

### 2026-09-25 — describes `v3.2.0`

- New words come one card at a time, each with a numbered ⏭ button to the next,
  and a word joins the deck only when its card is shown (§6, §5).
- Clip accent setting, American by default: `us`/`uk` serve that accent's
  channels first, then mixed ones, never the other accent; `any` serves all
  (§8.6, §15).
- The main menu is no longer `is_persistent`, so the back button on a phone
  closes it (§2.1).
- The league, all-time and Lazy boards open from the menu and commands again;
  only a callback query is acknowledged (§2.1).

### 2026-09-24 — describes `v3.0.2`

- Alignment is sent in batches of 25 and only for planned sentences and their
  neighbours (§8.4); Gemini 5xx retried, bare-array batches accepted (§9.2).

### 2026-09-24 — describes `v3.0.1`

- Thinking-model reasoning is dropped from LLM replies; content batches that
  match no word are warned about (§9.2).

### 2026-09-24 — describes `v3.0.0`

- The clip pipeline is rebuilt around one download per source video and local,
  frame-accurate cuts (§8.1, §8.4). A clip is one sentence in `segment_media`,
  shared by every word in it; `clip`, `user_clip_seen` and `clip_vote` are gone.
- Cuts come from forced alignment when the aligner sidecar runs, else from
  subtitle timing snapped to pauses; no more 3-second lead-in, and long
  sentences are skipped instead of truncated (§8.4).
- Channel feeds and raw subtitles are cached; yt-dlp runs with Node as its
  JavaScript runtime, a writable cookie copy, and a Redis bot-wall breaker (§8.2,
  §8.3).
- Pre-warm picks whole videos by marginal gain (§8.5).
- Clips are served one at a time with arrows, the word bolded, votes and a
  YouTube link; free search by typing (§8.6, §2.1).

### 2026-09-24 — describes `v2.2.0`

- Every learner feature is on a main-menu button; the admin panel has a button
  shown to admins only; the three boards link to each other (§2.1).
- `/league` and `/lazy` join the command menu, with Persian descriptions (§2.1).
- The nightly boards message carries a one-tap off button (§11.7).
- The broadcast prompt has a cancel button (§14).

### 2026-09-24 — describes `v2.1.0`

- League weeks start on **Saturday** and close on Friday; the rollover moved from
  Monday 01:00 to Saturday 00:00 (§11.4, §13).
- The rollover folds a lazily seeded bottom-tier membership into the learner's
  real league, so nobody holds two leagues in one week (§11.4).
- One-off `pnpm db:week-saturday` moves stored Monday-keyed leagues (§11.4).
- New **nightly boards** message at 22:00: the learner's league, the all-time
  board and the Lazy Board (§11.7, §13).
- The previously unused `digest_enabled` setting now controls it, with a toggle
  in the settings panel (§15).

### 2026-09-24 — describes `bfb3958`

- Initial extraction. Full pass over `apps/bot`, `apps/worker`, and `packages/{core,game,coach,content,media,queue,db,shared}`.
- Documented: Leitner scheduling, new-word selection, daily allowances, review
  flow, retention-aware progress, the corpus→clip pipeline, clip serving,
  mined and generated word content, the writing coach, points/streaks/leagues/
  buddies/lazy board, reminders, the scheduled job table, admin tooling, and
  user settings.
- Noted the cross-cutting invariants in §16.

---

## 1. What the product does

Teaches the 2,809-word NGSL vocabulary list on Telegram, where every word is
taught through **real video clips** of real speakers from a curated corpus rather
than through invented example sentences.

Three engines: a spaced-repetition scheduler, a clip pipeline whose expensive
work happens entirely before a user asks for anything, and a motivation layer
(points, streaks, weekly leagues).

`NGSL_SIZE = 2809` is declared in `apps/bot/src/handlers/start.ts`.

---

## 2. Access and onboarding

*Source: `apps/bot/src/handlers/start.ts`, `apps/bot/src/middlewares.ts`*

`/start` checks membership of the configured required channel, if one is set.

**`/start` is deliberately exempt from the channel gate.** A new user gets a
welcome and a join button rather than a bare refusal; the membership-check
callback is exempt for the same reason. Every other command sits behind the gate.

Statuses accepted as "member": creator, administrator, member, restricted.

**If the membership check itself throws, the user is let through.** A
misconfigured channel id must not lock every user out of the bot.

Locale is inferred from the Telegram account's language code on first contact,
persisted on the user row, and changeable later in settings. The locale
middleware wraps `next()` rather than setting a field, because everything
downstream resolves copy from an ambient locale scope that has to still be open
when handlers run.

An activity histogram (24 hourly buckets) is incremented fire-and-forget on every
update. It is the sole input to peak-hour reminders (§12).

### 2.1 Navigation

*Source: `apps/bot/src/keyboards.ts` (`MENU_LAYOUT`, `boardsNavKeyboard`), `apps/bot/src/index.ts` (`MENU_ROUTES`, `COMMANDS`)*

**Nothing is reachable only by typing a command.** The main menu has a button
for every learner feature:

| | |
|---|---|
| 📖 New words | 🔄 Review |
| 🔎 Search | ✍️ Writing |
| 📊 Progress | 🔥 Streak & points |
| 🏆 League | 😴 Lazy Board |
| ⚙️ Settings | |

Admins get an extra row, 🛠 Admin. The routes are a `Record<MenuKey, handler>`,
so a button added to the layout without a handler fails the build.

The menu is deliberately **not `is_persistent`**: a persistent reply keyboard
cannot be hidden, so on Android the back button left the chat instead of closing
it. The keyboard icon beside the input field brings it back. Telegram keeps the
keyboard a chat last received, so a learner gets the new behaviour on the next
`/start` or language change.

A board handler serves a menu button and a command (plain messages) as well as
the buttons under another board (callback queries), so it acknowledges only a
callback query. `answerCallbackQuery` on a message throws synchronously, before
any `.catch` can attach, which is how the boards once showed nothing from the
menu.

The three boards (league, all-time, Lazy Board) each carry buttons to the other
two, and the streak screen links to all three plus the buddy invite.

Commands mirror the menu. `/league` and `/lazy` are in the published command
list; `/admin` is deliberately not. Clients set to Persian get Persian command
descriptions, everyone else English.

---

## 3. Leitner scheduling

*Source: `packages/core/src/leitner.ts`, `packages/db/src/repositories/learning.repo.ts`*

Every word sits in one of five boxes per user. The box sets the next review
interval:

| Box | Interval |
|---|---|
| 1 | 1 day |
| 2 | 2 days |
| 3 | 4 days |
| 4 | 8 days |
| 5 | 16 days |

Box 5 is "mastered". Transitions:

- **correct** → up one box, capped at 5.
- **wrong** → straight back to box 1, not one step down. Models total loss.
- **known** → straight to box 5. This is the "I already know this" button; it
  skips the ladder rather than spending 16 days climbing it.

The scheduled interval always follows the **new** box, never the old one.

A newly introduced word starts at box 1, due tomorrow.

`recordReview` runs in a transaction with `SELECT … FOR UPDATE` on the user-word
row, so two rapid taps cannot interleave into a lost update. An append-only
`review_event` row is written in the same transaction; daily caps, streaks and
analytics all read from it. A review for a word not in the user's deck returns
undefined and is treated as a stale button, not an error.

---

## 4. New-word selection

*Source: `packages/db/src/repositories/learning.repo.ts` (`selectNewWords`)*

Two guarantees, both enforced in SQL rather than by scanning 2,809 rows in
memory:

**Mixed difficulty.** Words carry a frequency bucket 1–10 (1 = most frequent).
Candidates are drawn per bucket via `row_number() … partition by bucket`, so a
batch spans easy and hard words instead of clustering wherever `random()` landed.
The per-bucket quota is `ceil(limit / 10)`, floored at 1, so small requests still
reach every bucket.

**Clip readiness.** Within a bucket, words that already have a rendered,
non-disabled clip (through `word_occurrence` → `segment_media`) sort first, so
the learner rarely waits on a render.

Words already in the user's deck are excluded by an anti-join. The result is
shuffled.

Insertion uses `onConflictDoNothing`, so re-issuing a word is idempotent;
`addNewWords` returns how many rows were new, so a re-issued word earns no
points.

---

## 5. Daily allowances

*Source: `packages/core/src/time.ts`, `packages/queue/src/session.ts`, `packages/db/src/repositories/learning.repo.ts` (`getDailyLimits`)*

Two per-user targets: new words (default 5) and reviews (default 10).

Remaining allowance = target − work done **since local midnight in the user's own
timezone** (default `Asia/Tehran`). Two properties follow:

- The cap survives a bot restart, because it is derived from the database rather
  than held in memory.
- `remainingToday` clamps at zero, so lowering the target mid-day stops the
  session rather than producing a negative quota.

"New done today" counts `user_word.first_seen_at`; "reviews done today" counts
`review_event.created_at`. A new word enters `user_word` when its card is shown,
not when the session is chosen, so an abandoned session leaves the rest of the
day's allowance for the next one. Both compare against `date_trunc('day', now() at time
zone <tz>)`.

Every daily rollover in the system keys off `dayKey()`, which formats an instant
as `YYYY-MM-DD` in a given IANA zone.

---

## 6. Review sessions

*Source: `apps/bot/src/handlers/sessions.ts`, `packages/queue/src/session.ts`*

Due words are pulled **most-overdue first**, up to the remaining allowance.

**Reviews are strictly one card at a time.** The learner must answer before the
next card appears; batching them would make the Leitner signal meaningless.

**New words are one card at a time too**, but with nothing to answer: each card
carries a numbered **⏭ Next word (2/20)** button, and the last card has none and
is followed by the points earned and the closing line. The session
(`newWordDeck`) holds the word ids still to show and the one on screen:

- The session layer chooses the words and pre-warms their clips, but does **not**
  add them to the deck. Each word is added (`addNewWords`) when its card is
  shown, before the card is sent, so a word the learner saw always comes back
  for review.
- Points (`new_word`, `refId` = word id) are recorded per card, after it is
  delivered, and only when the word was new to the deck. Streak news is replied
  at once; the points are announced with the last card.
- Only the card on screen advances the session. The used button is removed and
  the rest of the card's buttons stay. A double tap, or a button left on an
  earlier session's card, just loses its button; a tap after the session ended
  gets a toast pointing to 📖 New words.
- Starting a new session replaces an unfinished one. Its unseen words were never
  added, so nothing is lost.

Implementation details that are load-bearing:

- The next card is **re-read from the database** each time, not cached in the
  session. The box may have changed, and the session must not become a second
  source of truth.
- A word that is no longer due is dropped from the queue and the queue advances,
  rather than stalling.
- After an answer the card's **buttons are removed**, so a double-tap cannot
  re-answer it.
- The callback is acknowledged **before** the database write, so the client's
  spinner stops even if the write is slow.
- The lemma is looked up directly after a review, because the word is no longer
  due and therefore no longer returned by the due-words query.

---

## 7. Progress and mastery

*Source: `packages/core/src/progress.ts`, `apps/bot/src/handlers/start.ts` (`progressHandler`)*

This was rebuilt because v1 reported a single number with two defects: a learner
who had genuinely mastered 100 words saw 3.5%, and a box-5 word reviewed
yesterday counted the same as a box-5 word 60 days overdue.

An **exponential forgetting curve** now sits on top of the box weight.

Box weights: 0.2, 0.4, 0.6, 0.8, 1.0 for boxes 1–5.

Retention uses the box's own review interval as the **half-life**:
`2 ^ (-daysSinceReview / intervalDays)`, capped at 1. So recall probability is
1.0 immediately after review, exactly 0.5 the moment the word falls due, and
decays after that. A word's live strength is `boxWeight × retention`, in [0, 1].
Words that have never been reviewed fall back to `firstSeenAt`.

Reported figures, each answering a different question:

- **`wordsLearned`** — deck size. Deliberately monotonic; never decreases.
- **`masteryPercent`** — how solid the knowledge is over what was actually
  studied (`masteryScore / wordsLearned`).
- **`ngslProgressPercent`** — v1's number, preserved: retention-weighted share of
  the whole list (`masteryScore / 2809`).
- **`needsRefresh`** — count of words whose strength fell below
  `REFRESH_THRESHOLD = 0.5`.

The headline figure never falls. Decay surfaces as "N words need a refresh",
which is an action, rather than as a percentage that drops while the user sleeps.

The progress screen renders a 10-cell bar (`▓`/`░`).

---

## 8. The clip pipeline

### 8.1 Why it is shaped this way

*Source: `apps/worker/src/vault.ts`, `packages/db/src/repositories/clips.repo.ts` (`saveSegmentMedia`)*

**No clip is ever rendered in response to a user request.**

Each clip is cut once, uploaded to a **vault** (a private forum topic), and
Telegram mints a reusable `file_id` for it. From then on, serving that video to
any user is a single API call: no download, no ffmpeg, no contact with YouTube on
the request path.

Those ids are **never expired**. The code notes that v1's 60-day TTL threw them
away and paid to rebuild them.

**A clip is one sentence, not one (sentence, word) pair.** `segment_media` is
keyed by segment. The cut depends only on the sentence, so one file serves every
NGSL word the sentence contains, and words reach clips through
`word_occurrence`. Before 3.0.0 the same sentence was rendered and uploaded once
per word it contained.

**Only YouTube-facing step: one download per source video.** Everything else,
from loudness to the cut itself, happens locally on that file. Before 3.0.0 every
clip was a separate yt-dlp extraction of its video (`--download-sections`),
which multiplied YouTube requests by the number of clips per video and was the
main trigger of the bot wall.

### 8.2 Corpus ingest

*Source: `packages/media/src/{ingest,enumerate,subtitles,segment,quality,lexicon}.ts`, `data/channels.yml`*

**Channel whitelist.** Quality is decided once, per channel, rather than per
search result. Each entry in `data/channels.yml` carries a comment with the
measured share of its videos that have human-authored English subtitles; that
share, not the channel's fame, decides whether it is worth crawling (the
Barack Obama campaign channel measured 0 of 12, the Obama White House archive
4 of 4 among its oldest uploads).

**The feed is read once and cached.** `enumerateChannel` reads a channel's whole
upload feed with `--flat-playlist` and stores every video with its `feed_index`
(1 = newest). Reaching the oldest uploads means paging through every newer one
anyway (measured: four and a half minutes for TED), so later runs take the next
`pending` videos straight from the database in the channel's crawl order. The
feed is re-read only after `ENUMERATE_TTL_DAYS` = 30, or with `--refresh`.
Shorts under 60 seconds are skipped.

**Human-authored subtitles only.** yt-dlp is invoked with `--write-subs` and
deliberately *without* `--write-auto-subs`. A video carrying only machine
captions produces no file, is recorded as `sub_status='none'`, and is **never
probed again**.

**The raw track is kept** in `video_subtitle`, so re-segmenting or re-aligning a
video never asks YouTube again.

**Crawl oldest-first.** YouTube retired community-contributed captions in
September 2020, so older uploads are likelier to carry real subtitles. Measured
in the code comments: on the 6 newest vs 6 oldest uploads, TED went 3/6 → 6/6 and
English Speeches went 0/6 → 6/6.

**Match `en.*`, not `en`.** Some channels publish `en-GB` and others `en-US`;
exact matching silently discarded both.

**Cue→sentence segmentation.** Raw subtitle cues break wherever the caption line
filled up:

```
[12.3s] "and that's why the apple"
[15.2s] "fell from the tree, which led Newton"
```

v1 clipped those directly, so a learner looking up "apple" got a clip ending
mid-thought. Consecutive cues are now accumulated until the text actually closes
a sentence. Rules:

- An abbreviation list (`mr`, `dr`, `etc`, `vs`, `us`, `uk`, …) prevents a
  trailing period from being read as a sentence end.
- A lone capital followed by a period (an initial, as in "J. F. Kennedy") does
  not terminate. A token with internal dots (`U.S.`, `e.g.`) does not either.
- `!` and `?` always terminate; only `.` is ambiguous.
- Non-speech annotations are stripped: `[APPLAUSE]`, `(laughter)`, `♪`.
- Rolling captions that repeat the previous line are detected and skipped.
- A single cue carrying **two** sentences ("Good morning. Today we will talk") is
  split inside the buffer, and the timestamp at the split point is
  **interpolated**. Second reason for the interpolation, per the code: identical
  timestamps would collide on the `(video_id, start_ms)` unique index.
- Flush happens *before* appending, so an oversized cue starts the next segment
  instead of being swallowed into a full one.
- Caps: 16,000 ms and 45 words per segment; minimum 4 words.

**Complete sentences.** A segment is `complete` when it starts where the
previous sentence ended (or at the top of the video) **and** closes on terminal
punctuation. A segment cut by the length cap is never complete, and neither is
the remainder that follows it. **Only complete segments are cut into clips**, so
a learner never gets half a thought.

**Quality score** (`packages/media/src/quality.ts`), in [0, 1], weighted:

| Component | Weight | Ideal |
|---|---|---|
| Length | 0.40 | 8–20 words |
| Sentence completeness | 0.25 | — |
| Pace | 0.20 | 1.8–4.2 words/sec |
| Cleanliness | 0.15 | — |

Cleanliness penalises >50% capitals (−0.5), leftover brackets (−0.2), opening on
a conjunction (−0.25), and not starting with a capital or quote (−0.15).

The score ranks sentences for rendering and serving; it does not discard them.

**NGSL resolution** (`packages/media/src/lexicon.ts`). Each sentence is resolved
to word ids once, at ingest, and written into `word_occurrence` as a precomputed
posting list, together with the **surface forms** the word appeared as ("went"
for go, "don't" for do and for not). Those forms are what a clip caption bolds,
so the bot needs no lemmatizer.

- **Contractions are expanded** via an explicit map, because NGSL's
  highest-frequency entries are exactly the words hiding inside them (`don't`
  conceals both `do` and `not`). Splitting on the apostrophe would yield the junk
  token `t`.
- **Typographic apostrophes are normalised.** Real subtitles use U+2019, not
  U+0027. Without this the token stream broke at the curly quote, yielding `don`
  and losing two of the highest-frequency entries in the list.
- Possessives (`world's`) are stripped before lookup.
- Three wink lemmatizers (verb, noun, adjective) are tried after a literal miss;
  they carry the irregular tables that matter here (`went`→`go`, `mice`→`mouse`,
  `better`→`good`) which suffix stripping would miss.

**Failure handling.** Each video is committed **independently**, so a run that
trips YouTube's bot wall keeps everything already indexed. On a bot-wall error the
channel is deliberately **stopped** — continuing makes it worse. A dead video is
marked and skipped. Segments are deduplicated by `start_ms` before insert, because
two rows sharing a `start_ms` in one statement makes Postgres raise "ON CONFLICT
DO UPDATE command cannot affect row a second time" and would abort the whole
video. Occurrences insert in chunks of 500 to stay under the parameter limit.
Indexing runs in one transaction, so `indexed_at` never reports partial state.

Default inter-video delay: 3,000 ms (`INGEST_REQUEST_DELAY_MS`).

### 8.3 Talking to YouTube

*Source: `packages/media/src/ytdlp.ts`, `packages/queue/src/bot-wall.ts`*

- **`--js-runtimes node` on every call.** Current yt-dlp solves YouTube's player
  challenges in JavaScript and enables only Deno by default. The images ship
  Node, so without the flag formats go missing.
- **Cookies are copied to a private, writable file** once per process. The real
  jar is mounted read-only, and yt-dlp writes the jar back on exit: pointed at
  the mount, every call crashed with `EROFS`. The copy also keeps the cookies
  YouTube rotates during the process's life.
- **Bot-wall detection** covers "confirm you're not a bot", HTTP 429 and "the
  current session has been rate-limited".
- **The bot-wall circuit breaker.** The first render job that meets the wall sets
  a Redis key for `BOT_WALL_PAUSE_MIN` = 90 minutes, and every render job checks
  it before starting and waits the pause out without spending a retry. It lives
  in Redis, not memory, so a restart cannot quietly resume the hammering.

### 8.4 Rendering a video

*Source: `apps/worker/src/workers/video-render.worker.ts`, `packages/media/src/{render,cut,align}.ts`, `services/aligner/app.py`*

One job per source video:

1. **Plan.** `renderPlan` picks the video's sentences worth cutting: complete,
   not yet cut, and not rejected by alignment. Sentences holding a word a learner
   is waiting on come first, then those helping the most words still below
   `PREWARM_DEPTH_TARGET`, then by quality. At most
   `RENDER_MAX_CLIPS_PER_VIDEO` = 60 per video. An empty plan marks the video
   rendered without downloading anything.
2. **Download once**, at most `CLIP_MAX_HEIGHT` = 480 pixels tall, choosing the
   **smallest file** at that height (`-S res:480,+size`). Every clip is
   re-encoded, so the source codec does not matter, and VP9 or AV1 is often half
   the size of H.264; the download is the slow, YouTube-facing step.
3. **Analyse the audio in one pass:** integrated loudness (EBU R128) and every
   pause (`silencedetect`, −35 dB, 150 ms).
4. **Forced alignment** (optional sidecar, `ALIGNER_URL`). Only the planned
   sentences and their immediate neighbours are aligned (`alignmentTargets`),
   in requests of 25 sentences: the aligner answers when a request is done, and
   Node's fetch gives up on a response whose headers take over five minutes,
   which a whole talk did on one CPU core. If a later batch fails, the batches
   already answered are kept. Each sentence text is aligned against its audio,
   with one second of context on each side, by a wav2vec2 CTC model; the result
   is when every word is really spoken, and a confidence score. Stored on the segment (`aligned_start_ms`,
   `aligned_end_ms`, `align_score`, `word_timings`), so a later render of the same
   video never re-aligns. A sentence whose first or last word cannot be aligned
   (a number, say) is left unaligned rather than guessed. A sentence scoring below
   `ALIGN_MIN_SCORE` = 0.35 is treated as text that does not match the audio, and
   is never cut. If the aligner is down, the job logs it and falls back.
5. **Cut window** (`cutWindow`):
   - aligned: from `CLIP_PAD_BEFORE_MS` = 250 before the first word to
     `CLIP_PAD_AFTER_MS` = 400 after the last, but never further than **halfway
     to the neighbouring sentence's words**, so a fast speaker's previous word
     never leaks in;
   - unaligned: the subtitle timing snapped into the nearest pauses within
     700 ms, the padding taken from inside the pause (`snapToSilence`).
   A sentence whose clip would exceed `CLIP_MAX_SEC` = 20 is **skipped, never
   truncated**. Before 3.0.0 every clip started 3 seconds early, and any sentence
   longer than about 11 seconds was cut off before its end.
6. **Encode** (`cutClip`): input-seeking with a re-encode, which is
   frame-accurate; H.264 `veryfast` CRF 26; audio at one per-video gain towards
   −16 LUFS (clamped to ±15 dB, measured over the whole talk because a per-clip
   normaliser pumps on short sentences), a limiter, and 40/60 ms fades so neither
   edge clicks; `+faststart` so Telegram starts playback before the file has
   loaded. A thumbnail is taken a third of the way in.
7. **Upload** with `supports_streaming`, width, height, duration and the
   thumbnail, spaced 4 s apart because a bot may post about 20 messages a
   minute into one group (often shared with the monitor's topics), and waiting
   out any 429. Each clip's `file_id` is saved
   as soon as it is minted, so a job that dies halfway keeps its clips.

**Pacing.** Worker concurrency 1; the queue is limited to
`RENDER_VIDEOS_PER_HOUR` = 12 downloads an hour, which is the whole exposure to
YouTube's bot wall. A permanently unusable source (dead, DRM) is retired
(`status = 'dead'`, `media_status = 'failed'`); clips already minted from it keep
playing.

### 8.5 Pre-warming

*Source: `packages/queue/src/video-render.queue.ts`, `packages/db/src/repositories/clips.repo.ts` (`videosToRender`, `videosForWord`)*

**Breadth** brings every word up to a floor (`PREWARM_BREADTH_TARGET` = 10) and
runs every 30 minutes; **depth** grows pools towards `PREWARM_DEPTH_TARGET` = 30
and runs nightly.

**Coverage is counted in distinct source videos, not clips** (`coveredCte`). A
talk that says "both" six times yields six clips in one render; counted as
clips, that looked well covered, no other video was planned for the word, and
its whole deck was one speaker. Only videos the default accent is served
(`us`, `mixed`, unlabelled) count, because clips an American-setting learner
never sees cover nothing for them. The render plan inside a video uses the same
measure.

**Videos are chosen by marginal gain:** the number of words still below target
that the video's eligible sentences would help, with British channels last
(their clips add no coverage). One download yields many clips,
so this greedy choice is what fills breadth fastest per YouTube request. A sweep
enqueues about an hour's worth (`RENDER_VIDEOS_PER_HOUR`); the worker's limiter
paces the actual downloads.

**Just-in-time.** The moment a session picks its words, or a learner opens a
word's clips, the best two unrendered videos containing each word below breadth
(British channels last) are enqueued at session priority, with the word marked as
*focus* so its sentences are cut and uploaded before anything else in those
videos. Failures are logged, never surfaced: a missing clip degrades a card, it
does not break a session.

**Deduplication.** Job ids are `video-<id>` (a hyphen: BullMQ rejects `:`), so a
video is never downloaded twice however many sweeps or learners ask. BullMQ
discards the new options and data of a duplicate, so the code does both by hand:
it merges the new focus words into the queued job and raises (never lowers) its
priority, reading `job.priority` rather than the stale `job.opts.priority`.
Active jobs are left alone.

### 8.6 Serving clips to a user

*Source: `apps/bot/src/handlers/clips.ts`, `apps/bot/src/highlight.ts`, `packages/db/src/repositories/clips.repo.ts`*

**One video at a time, YouGlish-style.** A deck of up to 30 clips opens with the
first; ⏮/⏭ swap the video inside the same message (`editMessageMedia`) and wrap
around. Everything is a cached `file_id`, so each tap is instant.

**Accent.** Each channel in `data/channels.yml` is `us`, `uk` or `mixed`
(speakers of both), copied to `channel.accent` on every ingest; an unlabelled
channel counts as mixed. The learner's `clip_accent` setting, **American by
default**, filters word decks and searches alike: `us` or `uk` keeps that accent's
channels and the mixed ones and drops the other accent; `any` keeps everything.
Within each round of one clip per video (below), the learner's own accent comes
before the mixed channels; it never outranks the round, or a word with a single
video in the learner's accent would show that whole talk first.
When a filtered deck is empty but other accents have clips, the learner is told
so and pointed at 🌐 All in settings, rather than told the clips are being
prepared.

**Deck order is fixed when it opens** and kept in the session: never-seen clips
first, and within them the first clip of every video before any video's second
(`row_number() partition by video`, ranked by net votes then quality; the
learner's own accent first within a round), so paging moves between speakers. A
search deck is ordered the same way, ranking within a video by text match. Seen clips follow, least recently seen first: a repeat
beats an empty screen. Arrows on an older message rebuild a word's deck; an old
search cannot be rebuilt from the callback, so the learner is asked to search
again.

**Caption:** the lemma or search as a header, the sentence with the target word
**bolded** (the stored surface forms for a word deck; Postgres `ts_headline` for
a search), the channel, and the position in the deck. Buttons: 👍/👎, and
**▶️ YouTube**, a link to the same moment in the full video.

**Seen is recorded only after Telegram accepts the clip**, so a failed send never
burns one. A clip whose `file_id` fails is dropped from the deck and the next one
tried, up to three times.

**Votes.** One vote per learner per clip (re-voting replaces it). With at least
five votes, a clip two-thirds disliked is taken out of rotation.

**Search.** 🔎 in the menu, `/search`, or simply typing an English word or phrase
(letters only, at most six words). An exact NGSL lemma opens that word's deck;
anything else, or a word with no clips of its own yet, is a phrase search
(`phraseto_tsquery`, word order kept) over every rendered sentence, backed by a
GIN full-text index. A lemma with nothing rendered is queued for rendering and
the learner told it is being prepared.

**A deliberate non-filter:** serving does **not** filter on source video status.
A rendered clip is a self-contained file on Telegram's CDN; the source being
removed from YouTube does not affect playback. The library is meant to outlive
its sources. (Planning *does* filter on `status = 'live'`, because a dead source
cannot produce new clips.)

---

## 9. Word content: examples and collocations

Two buttons per card. Both are a **single indexed read** — the content is mined
and generated offline precisely so these never wait on a corpus scan or an LLM.

### 9.1 Corpus-mined examples

*Source: `packages/content/src/{mine,readability}.ts`*

Per word: 60 candidate sentences are scored, the top 3 kept, subject to a
`minScore` of 0.5.

Readability answers a different question from clip quality. That one asked "is
this watchable?" (pace, duration, completeness). This one asks "can a learner who
knows roughly this much English *read* it?", which is lexical.

The dominant signal is **lexical coverage**: what share of the sentence the
learner plausibly already knows. An example is useless if understanding it
requires three words harder than the one being taught. Because the vocabulary is
closed and bucketed by frequency, that is directly computable rather than
approximated by a syllable formula like Flesch.

Crucially, **rarity is measured relative to the target word, not absolutely** —
"harder than the word being taught" is what makes an example unusable.

Weights: coverage 0.35, easiness 0.25, length (ideal 6–18 words) 0.20,
completeness 0.10, standalone 0.10. The standalone term zeroes a sentence opening
on a conjunction (`and`, `but`, `because`, `however`, …), because it reads as a
continuation of something the learner cannot see.

**An example not containing its target word scores 0**, whatever else it earns.

Every kept example retains its `segment_id`, so the card can offer a "watch this"
button that jumps to the moment the sentence was spoken. The code states that this
link is the entire reason to mine a corpus rather than call a dictionary API.

### 9.2 LLM-generated content

*Source: `packages/content/src/generate.ts`, `packages/llm/src/provider.ts`*

Examples are generated only for words the corpus could not cover (fewer than 2).
Collocations and idioms are generated for all words with fewer than 4, with the
explicit rationale that a collocation list is a **lexicographic judgement**, not
something countable out of 5,000 transcripts.

Operating rules:

- **Batch, offline, never on the request path.** The bot keeps working when the
  LLM is down, and cost does not scale with users.
- **The worker fills the gaps on its own** (`content.fill`, see §13): every half
  hour a run works for up to 29 minutes, collocations first, then examples.
  Both passes select only the words still missing content, so a run cut short
  by a restart, a deploy or a failed batch is simply continued by the next one.
  This replaced a command run by hand: its one full run saved no collocations,
  and nothing ran it again. At about two minutes per batch
  with a thinking model, every word's collocations take roughly half a day.
  Mining stays a manual command (`content mine`).
- 8 words per request: 2,809 individual calls is an order of magnitude more time
  and money than ~350 batched ones.
- A failed batch does not abandon the remaining words. **Every API key rate
  limited** is the exception: the pass stops, because every later batch would
  fail the same way and each failure is a warning mirrored to the monitor.
- **Output is verified:** a generated sentence not containing its target word is
  dropped.
- The prompt requires surrounding vocabulary to be high-frequency, the same
  criterion the corpus miner scores for.
- **A real failure is encoded in the schema.** The model periodically copied the
  shape example instead of choosing a value; an observed `"kind": "..."` failed
  the enum and discarded all eight words' phrases, not just the offending field.
  That one field is now **coerced rather than validated**, and the prompt carries
  a worked example instead of `"..."` placeholders.
- Caps: 3 examples and 5 collocations per word.
- **Only the answer is read from a thinking model.** Gemma 4 and Gemini 2.5
  return their reasoning as parts flagged `thought: true`; those are dropped
  (`geminiAnswerText`). Joined in, the reasoning's placeholder draft of the JSON
  was parsed instead of the answer and every word was silently discarded. The
  output budget defaults to 8,192 tokens so reasoning cannot crowd out a batch.
- A batch that parses but matches none of the requested words is logged as a
  warning rather than counted as a quiet success.
- Gemini `5xx` responses are retried twice (after 2 s and 6 s) before the batch
  counts as failed; a bare JSON array is accepted in place of `{"words": [...]}`.

Default model: `gemini-2.0-flash`; LLM timeout 60,000 ms.

---

## 10. The writing coach

*Source: `packages/coach/src/{coach,contracts,prompts}.ts`, `apps/bot/src/handlers/writing.ts`*

**1. Word selection.** 5 words drawn from **every box, the first boxes
favoured**, because writing with a word is how a shaky word becomes a mastered
one. Each slot draws a box first, with weights 5, 4, 3, 2, 1 for boxes 1 to 5
among the boxes that still have words, then a random word inside it. With every
box stocked, about 60% of the words come from boxes 1 and 2, and a mastered word
still turns up now and then so it stays in use.

The box is weighted rather than the word: fifty words marked "I know this" sit
in box 5, and weighted one by one they would crowd out the five the learner is
still struggling with. Below 3 words in the whole deck it throws
`NotEnoughWordsError` and the learner is sent to New words.

The earlier rule (box 4 and 5 only, falling back to box 3) refused every learner
whose words had not yet climbed that far, which in practice was most of them.

**2. Replay of recurring mistakes.** The rolling memory's grammar patterns are
shown **before** writing starts. The code's rationale: the point of tracking
recurring mistakes is that the learner sees them *while* writing, not only after.

**3. Parallel sample generation.** An independent native-quality sample of the
same task is generated fire-and-forget the moment the prompt is shown, so it is
normally ready long before the learner finishes and the comparison costs no
perceived latency. A failure here is **not surfaced**; it is regenerated on demand
at submission time. Temperature 0.8, 512 max output tokens.

**4. Length bounds.** 30–300 words. Too short teaches nothing, too long burns
context.

**5. Feedback.** Score 1–10, overall comment, vocabulary used and missing (≤20
each), ≤5 grammar issues, ≤5 suggestions, and a corrected text. Temperature 0.3,
2,048 max output tokens.

**Display order is deliberate:** the learner's own work and its correction first,
the native sample only afterwards, so the comparison lands on reflection.

**6. Rolling memory update.** The session is folded into a per-user summary: ≤5
grammar patterns, ≤10 missed vocabulary items, one note. This third LLM call
**must not delay the reply, nor fail it** — it is detached with its error caught.
Temperature 0.2.

Every LLM response is schema-validated before it reaches the database or the
user, so a model that drifts off-format degrades to a caught error rather than
writing malformed state into the rolling memory.

A free-text message is routed as a submission only when a session is open; the
check consults the database so it survives a cleared session. This check runs
**before** menu-label matching, so a paragraph starting with a button label is not
misrouted.

---

## 11. Motivation layer

### 11.1 Single entry point

*Source: `packages/game/src/activity.ts`*

Everything gamified flows through `recordActivity`. Handlers never compute points
themselves. In that one place: the streak advances at most once a day, the
resulting multiplier is applied to the award, and the points land in the
append-only ledger **and** the current league standing together, so a board can
never drift from the ledger.

**Ordering is deliberate:** the streak advances *before* the award, so a learner
who starts a new day with a review immediately gets that day's multiplier. The
alternative quietly under-paid the first action of every session.

### 11.2 Points

*Source: `packages/core/src/points.ts`*

| Reason | Points |
|---|---|
| `new_word` | 10 |
| `review_correct` | 5 |
| `writing_submitted` | 50 |
| `clip_watched` | 2 |
| `daily_goal` | 25 |
| `streak_milestone` | 100 |
| `quest_bonus` | 30 |

Weighted by **effort, not by ease of triggering**. Writing is worth ten reviews
because it is the hardest thing a learner can do here; clips are worth little
precisely because tapping a button is not learning.

- **Only a correct recall earns points.** A wrong answer is still progress, but
  paying for it would make the leaderboard reward volume over accuracy.
- **Milestone bonuses are excluded from the multiplier**, because they are already
  a reward for the streak and multiplying them compounds the same thing twice.
- **The ledger is append-only.** Nothing mutates a running total; every balance
  is a `SUM` over a window. A wrong leaderboard can always be traced back to the
  rows that produced it.

### 11.3 Streaks

*Source: `packages/core/src/streak.ts`*

The problem being solved, per the code: a plain consecutive-day counter has one
fatal flaw — the day it breaks, the learner's entire investment zeroes and they
churn. Three mechanics attack that.

**Freezes.** One earned per full week, banked to a cap of 2. A freeze absorbs a
missed day, one for one, so a slip does not erase months.

**A compounding multiplier.** Days 1–6 ×1.0, days 7–29 ×1.5, day 30+ ×2.0. This
is what turns the streak from a vanity number into an **asset with ongoing
yield**: breaking a 30-day streak costs future points, a far stronger motivator
than losing a counter.

**Milestones:** days 3, 7, 14, 30, 60, 100, 365.

Engineering properties that matter:

- **Lazy evaluation.** Misses are assessed on the learner's next activity, not by
  a nightly sweep. A worker outage therefore **can never silently break someone's
  streak**.
- **Idempotent within a day.** The first qualifying activity advances the streak;
  every later one is a no-op, so learning and reviewing on the same day cannot
  double-count.
- Clock skew or a corrected timezone that places "today" before the last recorded
  day is treated as already handled rather than rewinding the streak.
- Freezes are earned on completed weeks of the **new** streak length.

Display status: `none`, `active` (studied today), **`atRisk`** (studied yesterday,
not yet today — the nudge window), `broken`.

### 11.4 Weekly leagues

*Source: `packages/core/src/league.ts`, `packages/game/src/rollover.ts`, `packages/db/src/repositories/game.repo.ts` (`placeInLeague`)*

Rationale in the code: a single global leaderboard demotivates the ~90% who will
never approach the top — "rank 4,120 of 5,000" is a reason to quit.

Cohorts of `COHORT_SIZE = 30`, with 5 promoted and 5 relegated. Five tiers:
bronze, silver, gold, sapphire, diamond. Every learner stays near a boundary that
matters.

Guards:

- Top tier cannot promote; bottom tier cannot demote.
- **A learner who scored nothing is never promoted**, however empty the cohort.
- In a small cohort the promote and demote bands are shrunk to half the cohort so
  they **cannot overlap** — otherwise one user could appear in both.
- A tail smaller than half a cohort is merged into the previous cohort rather than
  left as a lonely group of two, which would make promotion meaningless.
- On rollover, **every member** of a closed cohort is placed into a new league at
  their new tier, including those who hold. The code names silently dropping out
  of the competition as the most common way a league system quietly dies.

**Lazy membership.** A learner is seeded into the current week's bottom-tier
league on first activity, not by a Saturday sweep, so someone who signs up mid-week
competes immediately instead of waiting six days.

**Weeks follow the Iranian calendar:** Saturday opens the week and Friday closes
it (`weekStartKey` returns the Saturday; `daysLeftInWeek` counts today, so 7 on
Saturday and 1 on Friday). The rollover runs at **Saturday 00:00**, the moment
Friday ends.

**One league per learner per week.** Someone who studies after midnight but
before the rollover has run is lazily seeded into the bottom tier first. The
rollover places learners with `placeInLeague`, which folds any other membership
of that week into the one it assigns, points included. Without it the learner
would sit in two cohorts, and every later rollover would carry both forward.
Re-running the rollover is a no-op.

**Switching from Monday weeks (2.1.0).** Leagues stored before 2.1.0 are keyed by
their Monday and are invisible to the Saturday-based code. `pnpm
db:week-saturday` rewrites them once: a finished week moves to the Saturday before
its Monday; the running week moves to the Saturday week that contains today
(which, on a Saturday or Sunday switch-over, is the week that has just begun, so
that league runs until the next rollover). Its members are then re-seated with
`placeInLeague`. The script only touches Monday-keyed rows, so a second run does
nothing.

An all-time global board also exists, and is deliberately secondary to the league.

### 11.5 Buddies

*Source: `packages/core/src/streak.ts` (`resolveBuddyDay`), `packages/game/src/rollover.ts`, `apps/bot/src/handlers/game.ts`*

Two users can pair. Their joint streak **only advances when both partners
studied**. The code names this both the strongest retention lever and a viral
loop: the invite is a Telegram deep link carrying the inviter's id, so accepting
is one tap and the invitee arrives already paired. Using the feature requires
bringing someone in.

**No freezes here** — the partner is the safety net.

Unlike personal streaks, this genuinely requires a nightly pass, because whether
both studied cannot be known until the day is over. Reconciliation therefore runs
on **yesterday**, not today.

Guards: a user cannot pair with themselves, and a pair is refused if either side
already has an active one.

### 11.6 The lazy board

*Source: `packages/db/src/repositories/game.repo.ts` (`lazyBoard`), `packages/core/src/streak.ts`*

Lists users who have missed `LAZY_THRESHOLD_DAYS = 3` or more consecutive days.

**Appearing requires explicit opt-in**, and that is the whole ethics of the
feature: the code states that an involuntary public shame list loses users and
invites moderation problems. Opting out is one tap, and the redemption path is
stated on the board itself.

The same opt-in list is part of the nightly boards message (§11.7), so opting in
means appearing in every recipient's chat, not only on `/lazy`.

### 11.7 Nightly boards

*Source: `apps/worker/src/jobs/nightly-boards.ts`, `apps/worker/src/jobs/boards-message.ts`, `packages/db/src/repositories/game.repo.ts` (`weekMemberships`, `globalRanks`)*

At **22:00** every learner who has not switched it off receives one message with
three boards:

1. **Their league this week**: tier, the top `BOARD_SIZE = 10` with the same
   🔼/🔽 zones as the in-bot screen, their own rank when they fall below the cut,
   and how long the week has left. On Friday the line says the league closes at
   midnight tonight. A learner with no league yet is told a lesson or review puts
   them in one.
2. **The all-time board**: top 10, plus their own rank when they are not in it.
3. **The Lazy Board**: up to 10 opted-in absentees (§11.6), or a line saying
   everyone is active.

The recipient is marked ⬅️ wherever they appear. A **🔕 button** under the
message (`dg:off`) turns it off in one tap and removes itself; settings turn it
back on. The worker and the bot share that callback string by convention, noted
at both ends.

Why 22:00: late enough to be the day's summary, early enough that a learner on
the Lazy Board or at risk of relegation can still study today.

**One message, not three**, so the evening costs one notification.

**Audience:** every non-blocked user with `digest_enabled` (default on). The
setting existed in the schema before 2.1.0 but no job read it.

**Skipped while nobody has points**, because an empty board is not worth a
notification.

**Cost:** the all-time board, every user's all-time rank, the week's memberships
and the Lazy Board are each read once per run, and each league's standings once
per league. Per-user work is only rendering. Sending shares the reminders'
pacing and blocked-user handling (§12).

Copy is duplicated in the worker for the same reason as the reminders' copy.

---

## 12. Reminders

*Source: `apps/worker/src/jobs/reminders.ts`, `apps/worker/src/jobs/dispatch.ts`, `packages/db/src/repositories/settings.repo.ts` (`remindersDueThisHour`)*

**Peak-hour nudges.** Runs hourly. The query selects only users whose personal
peak activity hour matches the current UTC hour **and** who have not studied today
in their own timezone. Each learner therefore receives at most one nudge a day, at
the time they are most likely to act.

Below `minInteractions = 5` the activity histogram is noise, so those users fall
back to `defaultHour = 17` rather than being reminded at whatever minute they
first opened the bot.

**Copy is conditional on streak status:** a streak at risk gets the at-risk line,
because that is a far stronger motivator than a generic nudge.

**Audience requires something to come back to** — a user with no words in their
deck is excluded.

**Morning motivation** goes out at 06:00 and, unlike nudges, is opt-in
(`motivationEnabled` defaults to false; `remindersEnabled` defaults to true).

Note on structure: reminder copy is **duplicated in the worker** rather than
imported from the bot's i18n catalogue. The worker is a separate process with no
request context, and carrying the bot's ambient locale scope across the queue
boundary would mean threading a locale through every job. These few strings are
the cheaper trade.

Send pacing 45 ms, to stay well under Telegram's ~30 msg/s. A 403 or 400 flags
the user as blocked so later bulk sends skip them; the flag is cleared on their
next interaction.

---

## 13. Scheduled jobs

*Source: `apps/worker/src/scheduler.ts`*

| Job | Cron |
|---|---|
| `reminders.peak` | `0 * * * *` |
| `motivation.daily` | `0 6 * * *` |
| `buddy.reconcile` | `30 0 * * *` |
| `league.rollover` | `0 0 * * 6` |
| `health.sync` | `0 3 * * 0` |
| `prewarm.breadth` | `*/30 * * * *` |
| `prewarm.depth` | `10 2 * * *` |
| `digest.daily` | `0 20 * * *` |
| `boards.nightly` | `0 22 * * *` |

The cron timezone is the app timezone, so "06:00" means 06:00 for the learners,
not UTC.

These are **durable repeatable queue jobs, not in-process cron**. Per the code,
v1 ran eight cron jobs inside the bot: nothing survived a restart, two instances
would double-fire, and a long job blocked user traffic. Worker concurrency for
scheduled work is 1.

`content.fill` (`*/30 * * * *`, *source: `apps/worker/src/workers/content-fill.worker.ts`*)
runs on a queue of its own, `content-fill`, because a half-hour run on the
schedule queue would hold back the reminders and the boards. On shutdown the
worker does not wait for it: each word is saved as its batch returns, and the
interrupted run is picked up again as a stalled job. `ENABLE_CONTENT_FILL=false`
turns it off.

### Weekly video health sync

*Source: `apps/worker/src/jobs/health-sync.ts`*

Probes 300 videos per pass, those whose last check is older than 7 days,
least-recently-probed first. Uses `yt-dlp --simulate` (metadata only, no media
bytes), so a few hundred probes stay inside the pacing budget.

A dead source is retired. **Clips keep their `telegram_file_id` and continue to
play indefinitely**; retiring the source only stops it producing *new* clips.

A **transient** verdict (rate limiting, network blip) says nothing about the
video, so `health_checked_at` is deliberately left untouched and it is retried
next sweep. A bot-wall verdict stops the pass.

### Release announcement

*Source: `apps/worker/src/jobs/release-announcement.ts`, `apps/worker/src/jobs/dispatch.ts`*

Not scheduled: it runs when the worker starts. If the version in
`apps/worker/package.json` differs from the last one announced (Redis
`ngsl:release:announced`), every learner who has not blocked the bot is told, in
their locale, which version it is and to tap /start. Telegram keeps the reply
keyboard a chat last received, so /start is how a learner picks up a changed
menu.

- **Paced** at one message per 200 ms, five a second, a sixth of Telegram's
  bulk limit.
- **Resumable.** Learners are reached in Telegram id order and the last one is
  recorded (`ngsl:release:<version>:cursor`) after each message, so a worker
  restarted midway continues instead of messaging anyone twice. Redis runs with
  AOF, so the record survives a restart.
- **Once per version.** Restarting the worker on the same version sends nothing.
- `ENABLE_RELEASE_ANNOUNCEMENT=false` turns it off.

Every bulk send (`deliver`) waits out a `429` for the `retry_after` Telegram
names and tries once more, rather than dropping the message; a `403`/`400`
flags the learner as blocked.

---

## 14. Admin

*Source: `apps/bot/src/handlers/admin.ts`, `packages/db/src/repositories/settings.repo.ts` (`adminStats`)*

Panel: user count, active today / this week, blocked count, words in decks, total
points awarded, rendered clips, live vs dead videos.

**Broadcast** goes to every non-blocked user at 40 ms intervals, with progress
edited into the status message every 250 recipients. It is **deliberately
detached**: a 10,000-user broadcast takes minutes and awaiting it would hold the
update handler open for the whole run. Each recipient is rendered in their own
locale. A 403/400 flags them as blocked so the next broadcast skips them.

The broadcast prompt has a ❌ Cancel button; typing `/cancel` still works.

Warnings and errors are mirrored into a Telegram technical topic when the monitor
is enabled.

Admin ids come from config; `isAdmin` gates both the panel and the broadcast
composer, and the broadcast route takes precedence over every other text route.

---

## 15. User settings

*Source: `apps/bot/src/handlers/settings.ts`, `packages/db/src/repositories/settings.repo.ts`*

| Setting | Default | Options |
|---|---|---|
| Daily new target | 5 | 3, 5, 10, 15, 20 |
| Daily review target | 10 | 5, 10, 20, 30, 50 |
| Preferred dictionary | cambridge | cambridge, oxford |
| Clip accent (`clip_accent`) | us | us → uk → any, one button cycling (§8.6) |
| Reminders | on | — |
| Morning motivation | off | — |
| Nightly boards (`digest_enabled`) | on | — |
| Lazy board opt-in | off | — |
| Timezone | Asia/Tehran | — |
| Locale | inferred | fa, en |

The panel is **rendered once and edited in place**, so changing four options
leaves one message in the chat rather than four. Callback data is kept terse
(`st:<field>:<value>`) to fit Telegram's 64-byte limit. After a language change
the panel and the reply keyboard switch together, re-rendered inside the new
locale.

Defaults are duplicated in the repository so a user with no settings row still
works, and they mirror the column defaults.

---

## 16. Cross-cutting invariants

These recur throughout the codebase and are worth stating once.

**Gamification never breaks a learning flow.** Points are awarded *after* cards
are delivered, and failures are caught and logged. Per the code: a points failure
must never cost the learner their words.

**Nothing expensive is on the request path.** Clip rendering, corpus mining and
content generation all happen ahead of time, in batch.

**Idempotence everywhere.** Re-marking a clip seen, re-issuing a word,
re-recording a study day, re-running a render job: all no-ops, not errors.

**Partial failure degrades, never blocks.** A missing clip weakens a card but does
not break the session. A missing native sample leaves the rest of the feedback
intact. A broken membership check lets the user through.

**Everything from an external source is escaped before display.** NGSL definitions
and YouTube captions are not guaranteed free of `<`, `>` or `&`, and one
unescaped ampersand is a Telegram 400 that breaks the whole card.

**Message order is a pedagogical decision, not a preference.** The learner's own
writing before the native sample; recurring mistakes before writing starts; the
streak before the award.

**Domain logic is pure and I/O-free.** `packages/core` imports nothing and is unit
tested; repositories are thin persistence wrappers around it. v1 kept two
parallel Leitner implementations — dead document methods plus the real atomic
update — and they were free to drift. The dependency direction is enforced by
`eslint-plugin-boundaries`, not by convention, because v1 had the same rule
written in prose and broke it in 11 files.

**Configuration is parsed and validated once, at startup.** Reading `process.env`
anywhere else is a lint error.

---

## Appendix: where to look

| Concern | Files |
|---|---|
| Leitner, progress, streaks, leagues, points, time | `packages/core/src/` |
| Activity recording, league rollover, buddy reconciliation | `packages/game/src/` |
| Writing coach, prompts, LLM contracts | `packages/coach/src/` |
| Corpus mining, readability, LLM content generation | `packages/content/src/` |
| Ingest, segmentation, lexicon, quality, clip rendering | `packages/media/src/` |
| Queues, session assembly, pre-warming | `packages/queue/src/` |
| Schema, repositories | `packages/db/src/` |
| Config, logging | `packages/shared/src/` |
| Commands, handlers, middleware, i18n | `apps/bot/src/` |
| Scheduler, jobs, workers, vault | `apps/worker/src/` |
