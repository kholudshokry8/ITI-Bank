import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'ui', 'data', 'scratch*'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // The domain layer must stay free of LLM and vector-store dependencies.
    files: ['src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            '**/infra/**',
            '**/app/**',
            'better-sqlite3',
            'fastify*',
            '@fastify/*',
            'unpdf',
          ],
        },
      ],
    },
  },
);
