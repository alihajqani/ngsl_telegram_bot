import { parse } from 'csv-parse/sync';
import { z } from 'zod';

/**
 * Parser for `data/ngsl.csv`.
 *
 * The real header is:
 *   Lemma,SFI Rank,SFI,Adjusted Frequency per Million (U),definition
 *
 * Note this contradicts v1's own documentation — both `CLAUDE.md` and
 * `.claude/skills/ngsl-selector/SKILL.md` describe `rank,word,frequency,pos,
 * definition_simple`, with a `pos` column that does not exist in the file. The
 * header below was read off the actual data, not the docs.
 *
 * 486 of the 2,809 rows carry quoted definitions containing commas
 * ("to own, possess, or hold something"), so a real CSV parser is mandatory —
 * splitting on commas silently corrupts a sixth of the list.
 */

/** Blank cells must become `undefined`, not 0 — z.coerce.number() maps '' to 0. */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const rowSchema = z.object({
  Lemma: z.string().trim().min(1),
  'SFI Rank': z.coerce.number().int().positive(),
  SFI: z.preprocess(blankToUndefined, z.coerce.number().optional()),
  'Adjusted Frequency per Million (U)': z.preprocess(
    blankToUndefined,
    z.coerce.number().int().nonnegative().optional(),
  ),
  definition: z.preprocess(blankToUndefined, z.string().trim().optional()),
});

export interface NgslRow {
  lemma: string;
  sfiRank: number;
  sfi: number | undefined;
  adjFreqPerMillion: number | undefined;
  definition: string | undefined;
}

export class NgslCsvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NgslCsvError';
  }
}

/**
 * Parse and validate the NGSL list. Pure — takes file contents, not a path — so
 * it is unit-testable without touching the filesystem.
 */
export function parseNgslCsv(contents: string): NgslRow[] {
  const records = parse(contents, {
    columns: true,
    skip_empty_lines: true,
    trim: false,
    bom: true,
  }) as Record<string, string>[];

  if (records.length === 0) {
    throw new NgslCsvError('NGSL CSV contained no data rows');
  }

  const rows: NgslRow[] = records.map((record, i) => {
    const result = rowSchema.safeParse(record);
    if (!result.success) {
      const detail = result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ');
      // +2 accounts for the header line and 1-based line numbering.
      throw new NgslCsvError(`NGSL CSV line ${i + 2} is invalid — ${detail}`);
    }
    const r = result.data;
    return {
      lemma: r.Lemma,
      sfiRank: r['SFI Rank'],
      sfi: r.SFI,
      adjFreqPerMillion: r['Adjusted Frequency per Million (U)'],
      definition: r.definition,
    };
  });

  assertUnique(rows, (r) => r.lemma.toLowerCase(), 'lemma');
  assertUnique(rows, (r) => String(r.sfiRank), 'SFI Rank');

  return rows;
}

/**
 * Both uniqueness guarantees are load-bearing: `word.lemma` carries a unique
 * index, and bucketing orders by `sfi_rank`, which ties would make ambiguous.
 * Better to fail here than to half-seed and debug it later.
 */
function assertUnique(rows: readonly NgslRow[], key: (row: NgslRow) => string, label: string): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const k = key(row);
    if (seen.has(k)) duplicates.add(k);
    seen.add(k);
  }
  if (duplicates.size > 0) {
    const sample = [...duplicates].slice(0, 5).join(', ');
    throw new NgslCsvError(
      `NGSL CSV has ${duplicates.size} duplicate ${label} value(s): ${sample}${
        duplicates.size > 5 ? ', …' : ''
      }`,
    );
  }
}
