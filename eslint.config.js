import tseslint from 'typescript-eslint';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.output/**',
      '**/.wxt/**',
      '**/gui/dist/**',
      '**/extension/.output/**',
      '**/coverage/**',
    ],
  },
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs', '**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // The codebase intentionally uses `any` in storage adapters, message buses,
      // and bridge passthroughs where the type really is generic.
      '@typescript-eslint/no-explicit-any': 'off',
      // `_def` access on Zod schemas, `as unknown as T` reshaping for tests,
      // and storage adapters all need this.
      '@typescript-eslint/no-unused-expressions': 'off',
      'no-console': 'off',
    },
  },
  {
    // Security boundary (P0-4): the `sid` must never enter page-adjacent memory.
    // Feature and UI code must reach Salesforce only through the worker-brokered
    // `sfApiFetch` route — never touch cookies or the sid-fetch route directly.
    // Only the background service worker (extension/entrypoints/background.ts)
    // and the thin client (extension/lib/salesforce-api.ts) may. The Event
    // Monitor still reads the sid via api.getSessionDetails() (not chrome.cookies
    // / getSidForUrls directly), so it does not trip these rules — its streaming
    // path is retired in PR2.
    files: ['extension/features/**/*.ts', 'extension/ui/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="chrome"][property.name="cookies"]',
          message:
            'chrome.cookies is worker-only. Feature/UI code must call the Salesforce API through the sfApiFetch worker route so the sid never reaches the page.',
        },
        {
          selector: 'Identifier[name="getSidForUrls"]',
          message:
            'getSidForUrls exposes the sid to the page. Route Salesforce calls through the sfApiFetch worker proxy instead.',
        },
        {
          selector: 'Literal[value="getSidForUrls"]',
          message:
            'getSidForUrls exposes the sid to the page. Route Salesforce calls through the sfApiFetch worker proxy instead.',
        },
      ],
    },
  },
];
