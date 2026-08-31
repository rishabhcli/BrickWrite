import eslint from '@eslint/js'
import prettier from 'eslint-config-prettier'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'artifacts/**',
      'dist/**',
      'node_modules/**',
      'public/catalog/**',
      'public/demos/**',
      'convex/_generated/**',
      '.catalog-fixture/**',
      '.share-dev/**',
      '.scratch-probe/**',
      '.vercel/**',
      '.wrangler/**',
      '.sources/**',
      // Agent scratch, untracked like every other entry above it. Without this,
      // `npm run lint` — which is `eslint .` — gives a different answer
      // depending on which spec-driven-development artifacts happen to be on
      // your disk, and a stray debug script in someone's working copy reports as
      // a lint failure in a repo that is clean. CI never sees the directory at
      // all, so the only effect was to train people to ignore local lint.
      '.superpowers/**',
    ],
  },
  {
    ...eslint.configs.recommended,
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.node },
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ...config.languageOptions,
      parserOptions: { jsx: true },
      globals: { ...globals.browser, ...globals.node },
    },
  })),
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    },
  },
  prettier,
)
