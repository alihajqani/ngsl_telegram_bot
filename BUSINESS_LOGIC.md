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
**Last verified:** 2026-09-24

---

## Changelog

Newest first. Record the commit whose behaviour the document now describes, not
the commit that edited the document.

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
non-disabled clip sort first, so the learner rarely waits on a render.

Words already in the user's deck are excluded by an anti-join. The result is
shuffled.

Insertion uses `onConflictDoNothing`, so re-issuing a word is idempotent.

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
`review_event.created_at`. Both compare against `date_trunc('day', now() at time
zone <tz>)`.

Every daily rollover in the system keys off `dayKey()`, which formats an instant
as `YYYY-MM-DD` in a given IANA zone.

---

## 6. Review sessions

*Source: `apps/bot/src/handlers/sessions.ts`, `packages/queue/src/session.ts`*

Due words are pulled **most-overdue first**, up to the remaining allowance.

**Reviews are strictly one card at a time.** The learner must answer before the
next card appears; batching them would make the Leitner signal meaningless. New
words, by contrast, are sent as one card per word in a single burst.

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

*Source: `apps/worker/src/vault.ts`, `packages/db/src/repositories/clips.repo.ts` (`saveClipFileId`)*

**No clip is ever rendered in response to a user request.**

Each clip is rendered once, uploaded to a **vault** (a private forum topic), and
Telegram mints a reusable `file_id` for it. From then on, serving that video to
any user is a single API call: no download, no ffmpeg, no contact with YouTube on
the request path.

Those ids are **never expired**. The code notes that v1's 60-day TTL threw them
away and paid to rebuild them.

### 8.2 Corpus ingest

*Source: `packages/media/src/{ingest,subtitles,enumerate,segment,quality,lexicon}.ts`, `data/channels.yml`*

**Channel whitelist.** Quality is decided once, per channel, rather than per
search result.

**Human-authored subtitles only.** yt-dlp is invoked with `--write-subs` and
deliberately *without* `--write-auto-subs`. A video carrying only machine
captions produces no file, is recorded as `sub_status='none'`, and is **never
probed again**.

**Crawl oldest-first.** YouTube retired community-contributed captions in
September 2020, so older uploads are likelier to carry real subtitles. Measured
in the code comments: on the 6 newest vs 6 oldest uploads, TED went 3/6 → 6/6 and
English Speeches went 0/6 → 6/6.

**Match `en.*`, not `en`.** Some channels publish `en-GB` and others `en-US`;
exact matching silently discarded both.

**Cue→sentence segmentation.** The most intricate part of the pipeline. Raw
subtitle cues break wherever the caption line filled up:

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
- Segment timing comes from whole cues, so a clip opens and closes on caption
  boundaries rather than mid-syllable.

**Quality score** (`packages/media/src/quality.ts`), in [0, 1], weighted:

| Component | Weight | Ideal |
|---|---|---|
| Length | 0.40 | 8–20 words |
| Sentence completeness | 0.25 | — |
| Pace | 0.20 | 1.8–4.2 words/sec |
| Cleanliness | 0.15 | — |

Cleanliness penalises >50% capitals (−0.5), leftover brackets (−0.2), opening on
a conjunction (−0.25), and not starting with a capital or quote (−0.15).

**This score is a ranking signal, not a filter.** Nothing is discarded: a
mediocre clip beats no clip when a word is rare.

**NGSL resolution** (`packages/media/src/lexicon.ts`). Each sentence is resolved
to word ids once, at ingest, and written into `word_occurrence` as a precomputed
posting list. This is why serving a word needs no search engine: the query
vocabulary is closed and known at build time.

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

**Failure handling.** Each video is registered and committed **independently**, so
a run that trips YouTube's bot wall keeps everything already indexed. On a
bot-wall error the channel is deliberately **stopped** — continuing makes it
worse. A dead video is marked and skipped. Segments are deduplicated by
`start_ms` before insert, because two rows sharing a `start_ms` in one statement
makes Postgres raise "ON CONFLICT DO UPDATE command cannot affect row a second
time" and would abort the whole video. Occurrences insert in chunks of 500 to
stay under the parameter limit. Indexing runs in one transaction, so
`indexed_at` never reports partial state.

Default inter-video delay: 3,000 ms (`INGEST_REQUEST_DELAY_MS`).

### 8.3 Rendering

*Source: `packages/media/src/clip.ts`, `apps/worker/src/workers/clip-render.worker.ts`*

The render window is computed **once**, when the clip row is created, and
persisted on it. Re-rendering therefore reproduces identical bytes while each
clip still matches its own sentence length. (v1 got determinism by using a fixed
3s/10s window for everything.)

Window: `CLIP_LEAD_SEC` = 3 lead, `CLIP_MAX_SEC` = 14 max length, 500 ms tail so
the last word is not cut mid-syllable, 2,000 ms floor so a very short sentence is
still watchable.

- `--download-sections` issues ranged requests for **only the bytes in the
  window**. This is what makes pre-warming thousands of clips affordable.
- Capped at **480p**: these are ~10-second clips on a phone, and height dominates
  both render time and upload size.
- `--force-keyframes-at-cuts` re-encodes the section. Stream-copying would snap
  to keyframes and drift the window by seconds, which is fatal at this length.
- Render timeout 300,000 ms. Temp directories are removed in `finally`, so a
  failure mid-upload cannot leak disk.

**Concurrency defaults to 1**, and the queue is rate-limited to
`PREWARM_RENDER_BUDGET` = 120 renders per hour. That budget is the stated number
of times per hour the system is willing to expose itself to YouTube.

The job re-checks for an existing `telegram_file_id` before rendering, because a
sweep and a live request can both ask for the same clip and a retried job may run
after a successful upload.

If the source is permanently unusable (dead or DRM), the video is disabled rather
than retried forever — **but every already-minted `file_id` is left intact**,
because those clips still play.

### 8.4 Pre-warming

*Source: `packages/queue/src/clip-render.queue.ts`*

**Breadth** brings every word up to a floor of rendered clips
(`PREWARM_BREADTH_TARGET` = 10), so no learner meets a word with nothing to show.
Runs every 30 minutes.

**Depth** grows pools further (`PREWARM_DEPTH_TARGET` = 30), so "five different
clips on every review" keeps holding for words people actually study. Runs
nightly.

Breadth runs first: a word with zero clips is broken, a word with ten is merely
less varied. Candidates are sorted **neediest first**, so a truncated run still
fixes the worst gaps. The backlog query orders by id so a truncated sweep resumes
where the last one stopped; without it the limit fell on heap order and two
identical sweeps enqueued different work.

**Just-in-time pre-warm.** The moment a session picks its words, their renders
are enqueued at session priority — before any card is rendered, so there is a real
head start. Failures are logged, never surfaced: a missing clip degrades a card,
it does not break a session.

Two sharp edges documented in the code:

1. **Priority is silently dropped on deduplication.** BullMQ dedupes by job id
   and, when the id exists, returns the existing job and discards the new
   options including priority. A learner asking for a word already sitting in the
   pre-warm backlog would inherit that job's low priority and wait behind the
   whole sweep. Priority is therefore promoted **explicitly**, reading
   `job.priority` (not `job.opts.priority`, which `changePriority` leaves stale),
   and **only ever raised, never lowered**, so a sweep cannot demote a clip a
   live request already promoted. Active jobs are skipped because
   `changePriority` throws on them.
2. **Scoped vs unscoped backlog.** The just-in-time path must use the
   *per-word* backlog query. Using the unscoped one queued a handful of unrelated
   words at session priority while the word the learner actually tapped stayed
   unrendered, so the reply never stopped saying "being prepared".

Job ids use a hyphen (`clip-<id>`), not a colon, because BullMQ rejects custom
job ids containing `:`.

### 8.5 Serving clips to a user

*Source: `apps/bot/src/handlers/clips.ts`, `packages/db/src/repositories/clips.repo.ts`*

Five clips per tap (`CLIPS_PER_REQUEST = 5`).

**A learner never sees the same clip twice.** A per-user `user_clip_seen` ledger
makes this an anti-join: five fresh clips on learning, five *different* ones on
every review. v1's embedded-array model had no stable clip identity and could not
express this at all.

**Speaker diversity.** Selection is ranked with `row_number() partition by video`,
so the batch spans five different videos rather than five consecutive lines from
one talk. The same partitioning is applied when clip rows are first materialised:
each video's best occurrence is taken before any video's second, because ordering
by raw quality alone packed the pool with consecutive lines from whichever single
talk scored highest, leaving the serving query nothing to diversify across.

**Pool exhaustion** falls back to least-recently-seen clips, and the user is told.
Showing a repeat beats showing nothing.

**A deliberate non-filter:** the serving query does **not** filter on source video
status. A rendered clip is a self-contained file on Telegram's CDN; the source
being removed from YouTube does not affect playback. Excluding these would
discard the vault's whole anti-fragile payoff — the library is meant to outlive
its sources. (The *render backlog* query does filter on `status = 'live'`, because
a dead source cannot produce new clips.)

**Clips are marked seen only after a successful send**, so a failure does not burn
clips the learner never watched. Marking is idempotent.

The five videos are sent as one media group. If a stale `file_id` fails the whole
group, it falls back to sending individually, so one bad clip cannot cost the user
the other four.

If nothing is rendered yet, the word is pushed to the front of the render queue
and the user is told it is being prepared, rather than shown an empty reply.

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
- 8 words per request: 2,809 individual calls is an order of magnitude more time
  and money than ~350 batched ones.
- A failed batch does not abandon the remaining words.
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

Default model: `gemini-2.0-flash`; LLM timeout 60,000 ms.

---

## 10. The writing coach

*Source: `packages/coach/src/{coach,contracts,prompts}.ts`, `apps/bot/src/handlers/writing.ts`*

**1. Word selection.** 5 words drawn from the **top boxes** (`minBox = 4`), because
the exercise is to write using words actually mastered, not ones met yesterday.
Falls back to box 3 so the feature stays usable for a learner without five
mastered words, rather than refusing outright. Below 3 words it throws
`NotEnoughWordsError` and the user is told.

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

The recipient is marked ⬅️ wherever they appear. The footer says how to turn the
message off.

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
