/**
 * `wink-lemmatizer` ships no type declarations.
 *
 * It is CommonJS and assigns its members dynamically, so Node's cjs-module-lexer
 * cannot synthesize named ESM exports — `import { verb } from 'wink-lemmatizer'`
 * type-checks but throws at runtime. Only the default import works, which is why
 * this declares a default object rather than named functions.
 */
declare module 'wink-lemmatizer' {
  /**
   * `this: void` is accurate — these are standalone functions hung off the
   * export object, not methods — and it lets them be destructured safely.
   */
  interface WinkLemmatizer {
    /** `mice` → `mouse` */
    noun(this: void, word: string): string;
    /** `went` → `go` */
    verb(this: void, word: string): string;
    /** `better` → `good` */
    adjective(this: void, word: string): string;
  }
  const lemmatizer: WinkLemmatizer;
  export default lemmatizer;
}
