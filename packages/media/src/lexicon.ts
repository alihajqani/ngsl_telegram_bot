import lemmatizer from 'wink-lemmatizer';

// Destructured from the default import: wink-lemmatizer is CommonJS and does not
// expose working named ESM exports (see wink-lemmatizer.d.ts).
const { adjective, noun, verb } = lemmatizer;

/**
 * Matches subtitle text against the closed NGSL vocabulary.
 *
 * This is why the design needs no search engine. The query vocabulary is known
 * at build time — 2,809 lemmas — so instead of indexing text for arbitrary
 * search, every sentence is resolved to word IDs once, at ingest, and written
 * straight into `word_occurrence` as a posting list.
 */

export interface LexiconEntry {
  id: number;
  lemma: string;
}

/**
 * Contractions must be expanded before lookup: NGSL's highest-frequency entries
 * are exactly the words hiding inside them ("don't" conceals both `do` and
 * `not`). Splitting on the apostrophe instead would yield the junk token "t".
 */
const CONTRACTIONS = new Map<string, string[]>([
  ["don't", ['do', 'not']], ["doesn't", ['does', 'not']], ["didn't", ['did', 'not']],
  ["can't", ['can', 'not']], ["cannot", ['can', 'not']], ["won't", ['will', 'not']],
  ["wouldn't", ['would', 'not']], ["shouldn't", ['should', 'not']],
  ["couldn't", ['could', 'not']], ["isn't", ['is', 'not']], ["aren't", ['are', 'not']],
  ["wasn't", ['was', 'not']], ["weren't", ['were', 'not']], ["haven't", ['have', 'not']],
  ["hasn't", ['has', 'not']], ["hadn't", ['had', 'not']], ["it's", ['it', 'is']],
  ["i'm", ['i', 'am']], ["i've", ['i', 'have']], ["i'll", ['i', 'will']],
  ["i'd", ['i', 'would']], ["you're", ['you', 'are']], ["you've", ['you', 'have']],
  ["you'll", ['you', 'will']], ["we're", ['we', 'are']], ["we've", ['we', 'have']],
  ["we'll", ['we', 'will']], ["they're", ['they', 'are']], ["they've", ['they', 'have']],
  ["they'll", ['they', 'will']], ["that's", ['that', 'is']], ["there's", ['there', 'is']],
  ["here's", ['here', 'is']], ["what's", ['what', 'is']], ["let's", ['let', 'us']],
  ["he's", ['he', 'is']], ["she's", ['she', 'is']], ["who's", ['who', 'is']],
]);

/** Keep internal apostrophes so contractions survive tokenization. */
const TOKEN = /[a-z][a-z']*/g;

/**
 * Real subtitles use typographic apostrophes: TED and English Speeches write
 * "Don’t" with U+2019, not U+0027. Without this the token stream breaks at the
 * curly quote, yielding the junk token "don" and losing both `do` and `not` —
 * two of the highest-frequency entries in the entire list.
 */
const normalizeApostrophes = (text: string): string =>
  text.replace(/[’‘ʼ´`]/g, "'");

export class Lexicon {
  private readonly byLemma = new Map<string, number>();

  constructor(entries: readonly LexiconEntry[]) {
    for (const entry of entries) {
      this.byLemma.set(entry.lemma.toLowerCase(), entry.id);
    }
  }

  get size(): number {
    return this.byLemma.size;
  }

  /**
   * Resolve one surface form to an NGSL word ID.
   *
   * Tries the literal token first, then the three wink lemmatizers. Those carry
   * the irregular tables that matter most here — `went`→`go`, `mice`→`mouse`,
   * `better`→`good` — which a suffix-stripping rule set would miss entirely.
   */
  resolve(token: string): number | undefined {
    const raw = normalizeApostrophes(token).toLowerCase().replace(/^'+|'+$/g, '');
    if (raw.length === 0) return undefined;

    // Possessives are frequent in speech ("the world's", "people's") and are not
    // contractions, so they are stripped here rather than in the contraction map.
    const word = raw.endsWith("'s") ? raw.slice(0, -2) : raw;
    if (word.length === 0) return undefined;

    const direct = this.byLemma.get(word);
    if (direct !== undefined) return direct;

    for (const lemmatize of [verb, noun, adjective]) {
      const base = lemmatize(word);
      if (base !== word) {
        const id = this.byLemma.get(base);
        if (id !== undefined) return id;
      }
    }
    return undefined;
  }

  /**
   * Each NGSL word in a sentence with the surface forms it appeared as
   * ("went" for go, "don't" for both do and not), lowercased with straight
   * apostrophes. Stored with the occurrence so a caption can bold exactly the
   * right tokens without the bot carrying a lemmatizer.
   */
  matchForms(text: string): Map<number, string[]> {
    const found = new Map<number, string[]>();
    for (const raw of normalizeApostrophes(text).toLowerCase().match(TOKEN) ?? []) {
      for (const token of CONTRACTIONS.get(raw) ?? [raw]) {
        const id = this.resolve(token);
        if (id === undefined) continue;
        const forms = found.get(id) ?? [];
        if (!forms.includes(raw)) forms.push(raw);
        found.set(id, forms);
      }
    }
    return found;
  }

  /** Distinct NGSL word IDs appearing in a sentence. */
  match(text: string): Set<number> {
    return new Set(this.matchForms(text).keys());
  }
}
