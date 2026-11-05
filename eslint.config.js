// ESLint flat config. Scope matters here (docs/plans/2026-11-04-lint-gate.md):
// `src/`, `index.ts` and `scripts/` are type-checked against tsconfig.json;
// `test/` is excluded from that tsconfig, so it gets the non-type-checked
// ruleset instead of a "file not included in project" parse error.
import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';

/** Shipped code and CLI scripts: type-aware rules. */
const TYPED = ['src/**/*.ts', 'index.ts', 'scripts/**/*.ts'];
/** Tests live outside tsconfig.json, so they cannot be type-checked. */
const UNTYPED = ['test/**/*.ts'];

/** The shared configs carry no `files` key; scope them to a target set. */
const scoped = (configs, files) => configs.map((config) => ({ ...config, files }));

export default [
  {
    ignores: ['node_modules/', 'dist/', 'coverage/', 'archive/', '.worktrees/', '**/*.js', '**/*.d.ts'],
  },

  ...scoped([js.configs.recommended, ...ts.configs['flat/recommended-type-checked']], TYPED),
  {
    files: TYPED,
    languageOptions: {
      parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': ts },
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      // scripts/ are CLIs and print to stdout; src/ must use src/logger.ts.
      'no-console': 'off',
    },
  },
  {
    files: ['src/**/*.ts', 'index.ts'],
    rules: { 'no-console': 'error' },
  },

  ...scoped([js.configs.recommended, ...ts.configs['flat/recommended']], UNTYPED),
  {
    files: UNTYPED,
    languageOptions: { parser },
    plugins: { '@typescript-eslint': ts },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // `any` in fixtures is legitimate; it is not a defect signal in test code.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },

  prettierConfig,
];
