import type { Locale } from './fa.js';

/**
 * English locale.
 *
 * Typed as `Locale`, so adding a key to `fa.ts` without translating it here is a
 * compile error rather than a Persian string leaking into an English session.
 */
export const en: Locale = {
  errors: {
    generic: '⚠️ Something went wrong. Please try again.',
    session: '⚠️ This message is out of date. Please start again.',
  },

  channel: {
    prompt:
      '👋 To use this bot, please join our channel first.\n\n' +
      'Once you have joined, tap “Check membership”.',
    joinButton: '📢 Join the channel',
    checkButton: '✅ Check membership',
    notJoined: '❌ You have not joined the channel yet.',
    joined: '✅ Membership confirmed. Welcome!',
  },

  start: {
    welcome:
      '📚 <b>Hello {name}!</b>\n\n' +
      'Learn English through the <b>{wordCount}</b> most useful words — ' +
      'with real clips from TED talks and BBC.',
    guide:
      '<b>How it works</b>\n\n' +
      '📖 <b>New words</b> — a few fresh words a day, with examples and clips\n' +
      '🔄 <b>Review</b> — the Leitner system brings each word back at the right time\n' +
      '🎬 <b>Clips</b> — the word in real speech, never the same clip twice\n' +
      '🔎 <b>Search</b> — type any English word or phrase to see it in clips\n' +
      '📊 <b>Progress</b> — see how far you have come\n\n' +
      'Pick something from the menu below 👇',
  },

  menu: {
    newWords: '📖 New words',
    review: '🔄 Review',
    writing: '✍️ Writing',
    streak: '🔥 Streak & points',
    progress: '📊 Progress',
    settings: '⚙️ Settings',
    league: '🏆 League',
    lazy: '😴 Lazy Board',
    admin: '🛠 Admin',
    search: '🔎 Search',
    prompt: 'Choose an option:',
  },

  newWords: {
    header: '📖 <b>{count} new words for today</b>',
    next: 'Next word ⏭ ({position}/{total})',
    ended: 'This session is over. Tap “{button}” for new words.',
    done: '✅ That is today’s batch. Try a review session to make them stick.',
    limitReached:
      '🎯 You have reached today’s limit of {target} words.\n' +
      'You can change it in Settings.',
    allSeen: '🎉 You have seen every word on the list! Only reviews remain.',
  },

  review: {
    header: '🔄 <b>{count} words to review</b>',
    empty: '✅ Nothing to review right now. Come back later.',
    limitReached: '🎯 You have reached today’s review limit of {target} words.',
    prompt: 'Do you know this word?',
    correct: '✅ Nice! <b>{lemma}</b> moved to box {box}.',
    wrong: '📌 No problem — <b>{lemma}</b> went back to box 1.',
    known: '⏭️ <b>{lemma}</b> marked as mastered and moved to box 5.',
    nextDue: 'Next review: in {days} days',
    sessionDone: '🎉 <b>Review complete!</b>\nYou reviewed {count} words.',
    buttons: {
      correct: '✅ I know it',
      wrong: '❌ I don’t know',
      known: '⏭️ I know this well',
    },
  },

  card: {
    word: '<b>{lemma}</b>',
    definition: '<i>{definition}</i>',
    box: '📦 Box {box}',
    reviewCount: '🔄 Reviewed {count}×',
    remaining: '<i>{count} more to go</i>',
    firstTime: '🆕 First time',
    buttons: {
      examples: '📝 Examples',
      collocations: '🔗 Collocations',
      clips: '🎬 Clips',
      dictionary: '📕 Dictionary',
    },
  },

  content: {
    examplesHeader: '📝 <b>Examples for “{lemma}”</b>',
    collocationsHeader: '🔗 <b>Collocations and idioms for “{lemma}”</b>',
    noExamples: 'No examples recorded for this word yet.',
    noCollocations: 'No collocations recorded for this word yet.',
    watchButton: '🎬 Watch in video',
    idiomTag: '💬',
  },

  clips: {
    header: '🎬 <b>“{lemma}” in real speech</b>',
    searchHeader: '🔎 <b>“{query}”</b>',
    caption: '{header}\n\n💬 {sentence}\n\n🎥 {channel} · {position}/{total}',
    preparing:
      '⏳ Clips for this word are still being prepared.\n' +
      'Please try again in a few minutes.',
    prev: '⏮ Prev',
    next: 'Next ⏭',
    like: '👍',
    dislike: '👎',
    youtube: '▶️ YouTube',
    voted: 'Thanks for the feedback!',
    removed: 'This clip is out of rotation. Thanks!',
    expired: 'These results are out of date. Please search again.',
    unavailable: 'This clip is no longer available.',
    otherAccent:
      'No clips for “{title}” in the {accent} accent yet.\n' +
      'You can set the accent to “{all}” in ⚙️ Settings.',
  },

  search: {
    prompt:
      '🔎 Send an English word or phrase to see it in real speech.\n' +
      'For example: <code>look forward to</code>',
    none: 'No clips for “{query}” yet.',
    invalid: 'Send English letters only, up to 6 words.',
  },

  writing: {
    prompt:
      '✍️ <b>Writing practice</b>\n\n' +
      'Write a text that uses these words:\n{words}\n\n' +
      '<i>Write between {min} and {max} words and send it here.</i>',
    memoryHeader: '🧠 <b>From your previous sessions</b>',
    notEnoughWords:
      '📚 Writing practice needs at least 3 of your words.\n' +
      'Learn a few from “📖 New words” first.',
    tooShort: '✏️ Your text is {words} words. Please write at least {min}.',
    tooLong: '✏️ Your text is {words} words. The maximum is {max}.',
    grading: '⏳ Reading your text...',
    llmUnavailable: '⚠️ The AI coach is unavailable. Please try again shortly.',
    feedbackHeader: '📝 <b>Feedback</b> — {score}/10 {stars}',
    used: '✅ Target words used: {words}',
    missed: '⬜ Not used: {words}',
    issuesHeader: '<b>Grammar notes</b>',
    suggestionsHeader: '<b>Suggestions</b>',
    correctedHeader: '✏️ <b>Your text, corrected</b>',
    sampleHeader: '🎓 <b>How a native writer did it</b>',
    sampleNote: 'Written independently, without seeing your text — compare the styles.',
    cancelButton: '❌ Cancel',
    cancelled: 'Writing practice cancelled.',
  },

  game: {
    streakHeader: '🔥 <b>Your standing</b>',
    streakLine: '{flame} Current streak: <b>{current}</b> days  (best: {longest})',
    multiplierLine: '⚡ Points multiplier: <b>×{multiplier}</b>',
    freezeLine: '🧊 Streak freezes: <b>{freezes}</b>',
    pointsLine: '⭐ Total points: <b>{points}</b>',
    atRisk: '⚠️ You have not studied today — your streak is at risk!',
    buddyLine: '🤝 Joint streak with your buddy: <b>{streak}</b> days',
    leagueButton: '🏆 League',
    globalButton: '🌍 All-time',
    lazyButton: '😴 Lazy Board',
    buddyButton: '🤝 Buddy',
    leagueHeader: '🏆 <b>{tier} league</b> — this week',
    leagueFooter: '<i>🔼 Top five promote, 🔽 bottom five relegate.</i>',
    noLeague: 'You are not in a league yet. Start a lesson to join.',
    globalHeader: '🌍 <b>All-time leaders</b>',
    yourRank: 'Your rank: <b>{rank}</b> with {points} points',
    tiers: {
      bronze: 'Bronze',
      silver: 'Silver',
      gold: 'Gold',
      sapphire: 'Sapphire',
      diamond: 'Diamond',
    },
    buddyInvite:
      '🤝 <b>Study buddy</b>\n\n' +
      'Send this link to a friend. Your joint streak only advances on days when ' +
      '<b>both</b> of you study.\n\n{link}',
    buddyActive: '🤝 You have a buddy — joint streak: <b>{streak}</b> days',
    buddyPaired: '🎉 You are paired! Your joint streak starts today.',
    buddyTaken: 'One of you already has a buddy.',
    buddySelf: 'You cannot be your own buddy 🙂',
    lazyHeader: '😴 <b>The Lazy Board</b>',
    lazyEmpty: 'Nobody here — everyone is active! 🎉',
    lazyDays: '{days} days away',
    lazyRedemption: '<i>One study session is all it takes to get off this board.</i>',
    lazyOptIn: '✅ Join',
    lazyOptOut: '❌ Leave',
    lazyJoined: 'You joined the Lazy Board (opt-in).',
    lazyLeft: 'You left the Lazy Board.',
    earned: '⭐ +{points} points',
    milestone: '🎉 <b>{days} day streak!</b> +{bonus} bonus points',
    freezeUsed: '🧊 A streak freeze was used — your streak survived!',
  },

  settings: {
    header: '⚙️ <b>Settings</b>',
    newTarget: '📖 New words per day: <b>{value}</b>',
    reviewTarget: '🔄 Reviews per day: <b>{value}</b>',
    hint: '<i>Tap a number to change it.</i>',
    newLabel: '— new words per day —',
    reviewLabel: '— reviews per day —',
    dictionary: '📕 Dictionary: {value}',
    dict: { cambridge: 'Cambridge', oxford: 'Oxford' },
    accent: '🗣 Clip accent: {value}',
    accents: { us: '🇺🇸 American', uk: '🇬🇧 British', any: '🌐 All' },
    remindersOn: '🔔 Reminders: on',
    remindersOff: '🔕 Reminders: off',
    motivationOn: '🌅 Daily motivation: on',
    motivationOff: '🌅 Daily motivation: off',
    digestOn: '🌙 Nightly boards: on',
    digestOff: '🌙 Nightly boards: off',
    digestStopped: '🔕 Nightly boards turned off. Turn them back on in ⚙️ Settings.',
    shameOn: '😴 Lazy Board: joined',
    shameOff: '😴 Lazy Board: not joined',
    language: '🌐 Language: {value}',
    languageChanged: '✅ Language changed.',
    saved: 'Saved',
  },

  progress: {
    header: '📊 <b>Your progress</b>',
    body:
      '{bar}  {percent}%\n\n' +
      '📚 Words learned: <b>{learned}</b>\n' +
      '🎯 Mastery: <b>{mastery}%</b>\n' +
      '🔁 Need a refresh: <b>{refresh}</b>\n\n' +
      '<i>out of {total} words on the list</i>',
  },
};
