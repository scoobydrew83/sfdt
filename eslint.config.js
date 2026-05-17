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
];
