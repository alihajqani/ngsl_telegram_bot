import { generateCollocations, generateExamples, generateWordDetails } from '@ngsl/content';
import { createLogger } from '@ngsl/shared';

const log = createLogger('worker.content-fill');

/**
 * Fill missing word content for up to `budgetMs`: collocations, then grammar
 * details, then examples.
 *
 * Content used to be a command run by hand: its one full run saved no
 * collocations, and nothing ran it again. Both passes select only the words
 * still missing content, so each run carries on where the last one stopped,
 * retries the batches that failed, and costs two queries once everything is
 * filled.
 *
 * Collocations go first because nothing else supplies them; most words already
 * have examples mined from the corpus.
 */
export async function runContentFill(budgetMs: number): Promise<void> {
  const deadline = Date.now() + budgetMs;

  const collocations = await generateCollocations({ deadline });
  const details = Date.now() < deadline ? await generateWordDetails({ deadline }) : undefined;
  const examples = Date.now() < deadline ? await generateExamples({ deadline }) : undefined;

  const considered =
    collocations.wordsConsidered +
    (details?.wordsConsidered ?? 0) +
    (examples?.wordsConsidered ?? 0);
  if (considered > 0) log.info('Content fill run finished', { collocations, details, examples });
}
