import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

/**
 * v1's CLAUDE.md declared "all queries go through the repository layer" and the
 * rule was broken in 11 files, because nothing enforced it. Here the layering is
 * a lint error, not a comment.
 */
export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/drizzle/**', 'eslint.config.js'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { project: './tsconfig.lint.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app', pattern: 'apps/*' },
        { type: 'shared', pattern: 'packages/shared' },
        { type: 'core', pattern: 'packages/core' },
        { type: 'db', pattern: 'packages/db' },
        { type: 'media', pattern: 'packages/media' },
        { type: 'queue', pattern: 'packages/queue' },
        { type: 'llm', pattern: 'packages/llm' },
        { type: 'content', pattern: 'packages/content' },
        { type: 'coach', pattern: 'packages/coach' },
        { type: 'game', pattern: 'packages/game' },
        { type: 'monitor', pattern: 'packages/monitor' },
      ],
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read configuration through config() from @ngsl/shared, never process.env.',
        },
      ],
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          rules: [
            // core is the domain: pure, dependency-free, universally importable.
            { from: 'core', allow: [] },
            { from: 'shared', allow: [] },
            { from: 'db', allow: ['shared', 'core'] },
            { from: 'media', allow: ['shared', 'core', 'db'] },
            { from: 'queue', allow: ['shared', 'core', 'db'] },
            { from: 'llm', allow: ['shared', 'core'] },
            { from: 'game', allow: ['shared', 'core', 'db'] },
            { from: 'monitor', allow: ['shared'] },
            { from: 'coach', allow: ['shared', 'core', 'db', 'llm'] },
            { from: 'content', allow: ['shared', 'core', 'db', 'media', 'llm'] },
            { from: 'app', allow: ['shared', 'core', 'db', 'media', 'llm', 'queue', 'content', 'coach', 'game', 'monitor'] },
          ],
        },
      ],
    },
  },
  // Config files and entry points legitimately touch process.env.
  {
    files: ['**/*.config.ts', '**/*.config.js', 'packages/shared/src/config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
