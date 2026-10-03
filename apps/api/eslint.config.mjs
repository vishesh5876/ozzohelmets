import base from '@helmet/eslint-config/base';
import globals from 'globals';

export default [
  ...base,
  {
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      // NestJS DI relies on runtime class references in constructor parameters.
      '@typescript-eslint/consistent-type-imports': 'off',
      'no-console': 'off',
    },
  },
];
