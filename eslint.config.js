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
    // `sfApiFetch` route (and the `sfApiStream` Port for streaming) — never touch
    // cookies, the sid-fetch route, or getSessionDetails directly. Only the
    // background service worker (extension/entrypoints/background.ts) and the
    // worker modules (extension/lib/sf-api-proxy.ts, sf-stream-worker.ts) join
    // the sid to a request. As of PR2 there are ZERO exceptions.
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
        {
          selector: 'Identifier[name="getSessionDetails"]',
          message:
            'getSessionDetails exposed the sid to the page and was removed in P0-4 PR2. Stream via the sfApiStream Port instead.',
        },
      ],
    },
  },
];
