export * as schema from './schema.js';
export * from './schema.js';
export { db, assertDatabaseReady, closeDatabase, type Database } from './client.js';

export {
  ensureClipsForWord,
  selectUnseenClips,
  selectSeenFallback,
  selectClipsForUser,
  markClipsSeen,
  findClipsToRender,
  findClipsToRenderForWord,
  saveClipFileId,
  markVideoDead,
  disableClips,
  clipCoverage,
  type ServableClip,
  type ClipRenderJob,
  type WordClipCoverage,
} from './repositories/clips.repo.js';

export {
  getDailyLimits,
  selectNewWords,
  addNewWords,
  getDueWords,
  recordReview,
  getProgressInputs,
  getMasteredWords,
  countDeck,
  getWordLemma,
  type WordCard,
  type ReviewCard,
  type DailyLimits,
  type ReviewOutcome,
} from './repositories/learning.repo.js';

export {
  findExampleCandidates,
  saveCorpusExamples,
  saveLlmExamples,
  saveCollocations,
  wordsMissingExamples,
  wordsMissingCollocations,
  contentCoverage,
  getWordContent,
  type ExampleCandidate,
  type CorpusExampleInput,
  type LlmExampleInput,
  type CollocationInput,
  type WordNeedingContent,
  type ContentCoverage,
  type WordContent,
} from './repositories/content.repo.js';

export {
  upsertUser,
  findUserByTelegramId,
  setLocale,
  touchActivity,
  type AppUserRecord,
} from './repositories/users.repo.js';

export {
  createWritingSession,
  findOpenSession,
  saveAiSample,
  saveSubmission,
  cancelSession,
  getWritingSummary,
  upsertWritingSummary,
  type WritingSessionRecord,
  type WritingSummaryRecord,
} from './repositories/writing.repo.js';

export {
  awardPoints,
  totalPoints,
  globalLeaderboard,
  globalRank,
  globalRanks,
  getStreak,
  saveStreak,
  studiedOn,
  findOrCreateLeague,
  joinLeague,
  placeInLeague,
  weekMemberships,
  currentMembership,
  addLeaguePoints,
  leagueStandings,
  leaguesForWeek,
  findBuddy,
  createBuddyPair,
  saveBuddyStreak,
  activeBuddyPairs,
  lazyBoard,
  setWallOfShameOptin,
  type LeaderboardRow,
  type BuddyRecord,
  type LazyRow,
} from './repositories/game.repo.js';

export {
  getSettings,
  updateSettings,
  adminStats,
  broadcastAudience,
  flagBlocked,
  remindersDueThisHour,
  dailyDispatchAudience,
  videosToProbe,
  markVideoHealthy,
  markVideoDeadById,
  type Settings,
  type AdminStats,
  type ReminderTarget,
} from './repositories/settings.repo.js';
