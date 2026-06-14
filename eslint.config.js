import js from '@eslint/js';
import ts from '@typescript-eslint/eslint-plugin';
import parser from '@typescript-eslint/parser';
import prettierConfig from 'eslint-config-prettier';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default [
  // Base JavaScript recommended rules
  js.configs.recommended,
  
  // TypeScript flat config (replaces legacy eslintrc format)
  ...ts.configs['flat/recommended-type-checked'],
  
  {
    files: ['**/*.ts'],
    plugins: {
      '@typescript-eslint': ts,
    },
    languageOptions: {
      parser: parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      // TypeScript specific
      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      
      // General
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettierConfig,
  {
    ignores: [
      'node_modules/',
      'dist/',
      '*.d.ts',
      '*.js',
    ],
  }
];
