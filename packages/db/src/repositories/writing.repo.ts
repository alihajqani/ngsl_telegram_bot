import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { db, type Database } from '../client.js';
import { writingSession, writingSummary } from '../schema.js';

/**
 * Writing coach persistence.
 *
 * A session is created when the prompt is shown, not when the text arrives —
 * that is what gives the independent AI sample somewhere to land while the
 * learner is still typing.
 */

export interface WritingSessionRecord {
  id: number;
  targetLemmas: string[];
  aiSampleText: string | null;
  submittedText: string | null;
}

export interface WritingSummaryRecord {
  grammarPatterns: string[];
  missedVocabulary: string[];
  sessionCount: number;
  lastSessionNote: string | null;
}

export async function createWritingSession(
  userId: number,
  targetLemmas: readonly string[],
  database: Database = db(),
): Promise<number> {
  const [row] = await database
    .insert(writingSession)
    .values({ userId, targetLemmas: [...targetLemmas] })
    .returning({ id: writingSession.id });
  return row!.id;
}

/**
 * The most recent session still awaiting a submission.
 *
 * Looked up by user rather than trusting an id held in the Telegram session, so
 * a restarted bot or a cleared session cannot orphan an in-flight write.
 */
export async function findOpenSession(
  userId: number,
  database: Database = db(),
): Promise<WritingSessionRecord | undefined> {
  const [row] = await database
    .select({
      id: writingSession.id,
      targetLemmas: writingSession.targetLemmas,
      aiSampleText: writingSession.aiSampleText,
      submittedText: writingSession.submittedText,
    })
    .from(writingSession)
    .where(and(eq(writingSession.userId, userId), isNull(writingSession.submittedText)))
    .orderBy(desc(writingSession.createdAt))
    .limit(1);
  return row;
}

/** Store the independent sample as soon as it is generated. */
export async function saveAiSample(
  sessionId: number,
  text: string,
  database: Database = db(),
): Promise<void> {
  await database
    .update(writingSession)
    .set({ aiSampleText: text })
    .where(eq(writingSession.id, sessionId));
}

export async function saveSubmission(
  sessionId: number,
  submission: {
    submittedText: string;
    correctedText: string;
    score: number;
    feedback: string;
  },
  database: Database = db(),
): Promise<void> {
  await database
    .update(writingSession)
    .set(submission)
    .where(eq(writingSession.id, sessionId));
}

/** Abandon an open session without recording an attempt. */
export async function cancelSession(
  sessionId: number,
  database: Database = db(),
): Promise<void> {
  await database.delete(writingSession).where(eq(writingSession.id, sessionId));
}

export async function getWritingSummary(
  userId: number,
  database: Database = db(),
): Promise<WritingSummaryRecord | undefined> {
  const [row] = await database
    .select({
      grammarPatterns: writingSummary.grammarPatterns,
      missedVocabulary: writingSummary.missedVocabulary,
      sessionCount: writingSummary.sessionCount,
      lastSessionNote: writingSummary.lastSessionNote,
    })
    .from(writingSummary)
    .where(eq(writingSummary.userId, userId));
  return row;
}

/**
 * Merge the rolling memory forward.
 *
 * `session_count` is incremented in SQL rather than read-modify-written, so two
 * submissions landing close together cannot lose one.
 */
export async function upsertWritingSummary(
  userId: number,
  summary: {
    grammarPatterns: string[];
    missedVocabulary: string[];
    lastSessionNote: string;
  },
  database: Database = db(),
): Promise<void> {
  await database
    .insert(writingSummary)
    .values({ userId, sessionCount: 1, ...summary })
    .onConflictDoUpdate({
      target: writingSummary.userId,
      set: {
        grammarPatterns: sql`excluded.grammar_patterns`,
        missedVocabulary: sql`excluded.missed_vocabulary`,
        lastSessionNote: sql`excluded.last_session_note`,
        sessionCount: sql`${writingSummary.sessionCount} + 1`,
        updatedAt: new Date(),
      },
    });
}
