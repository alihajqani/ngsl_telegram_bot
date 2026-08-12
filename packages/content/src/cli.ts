import { closeDatabase, contentCoverage } from '@ngsl/db';
import { createLogger } from '@ngsl/shared';
import { generateCollocations, generateExamples } from './generate.js';
import { mineAll } from './mine.js';

const log = createLogger('content.cli');

const USAGE = `
Usage: pnpm content <command> [options]

  status         Report example and collocation coverage
  mine           Mine authentic examples from the indexed corpus (no LLM)
  examples       LLM-generate examples for words the corpus could not cover
  collocations   LLM-generate 5 collocations/idioms per word
  all            mine, then examples, then collocations

Options:
  --limit=<n>    Cap how many words an LLM pass handles (smoke test first)
  --per-word=<n> Examples to keep when mining (default 3)
  --min-score=<f> Readability floor when mining (default 0.5)
`;

const flag = (argv: readonly string[], name: string): string | undefined =>
  argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

async function status(): Promise<void> {
  const c = await contentCoverage();
  const pct = (n: number) => `${Math.round((n / Math.max(1, c.words)) * 100)}%`;
  console.log(`
  words                      ${c.words}
  with corpus examples       ${c.withCorpusExamples}  (${pct(c.withCorpusExamples)})
  with LLM examples          ${c.withLlmExamples}  (${pct(c.withLlmExamples)})
  with collocations          ${c.withCollocations}  (${pct(c.withCollocations)})

  corpus examples            ${c.corpusExamples}
  llm examples               ${c.llmExamples}
  collocations               ${c.collocations}
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv.find((a) => !a.startsWith('--')) ?? 'status';

  if (argv.includes('--help')) {
    console.log(USAGE);
    return;
  }

  const limit = flag(argv, 'limit') ? Number(flag(argv, 'limit')) : undefined;
  const mineOptions = {
    perWord: flag(argv, 'per-word') ? Number(flag(argv, 'per-word')) : undefined,
    minScore: flag(argv, 'min-score') ? Number(flag(argv, 'min-score')) : undefined,
  };

  switch (command) {
    case 'status':
      await status();
      return;

    case 'mine': {
      const stats = await mineAll(mineOptions);
      console.log(
        `\n  mined ${stats.examplesSaved} examples for ${stats.wordsWithExamples} of ${stats.wordsProcessed} words\n`,
      );
      return;
    }

    case 'examples': {
      const stats = await generateExamples({ limit });
      console.log(
        `\n  generated ${stats.itemsWritten} examples for ${stats.wordsWritten} words ` +
          `(${stats.batchesFailed} batches failed)\n`,
      );
      return;
    }

    case 'collocations': {
      const stats = await generateCollocations({ limit });
      console.log(
        `\n  generated ${stats.itemsWritten} collocations for ${stats.wordsWritten} words ` +
          `(${stats.batchesFailed} batches failed)\n`,
      );
      return;
    }

    case 'all':
      // Mine first: it is free, and it shrinks the LLM's workload.
      await mineAll(mineOptions);
      await generateExamples({ limit });
      await generateCollocations({ limit });
      await status();
      return;

    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  log.error('Content pass failed', { error });
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
