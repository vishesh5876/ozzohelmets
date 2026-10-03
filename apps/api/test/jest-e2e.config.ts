import type { Config } from 'jest';

const config: Config = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '..',
  roots: ['<rootDir>/test'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleNameMapper: { '^@helmet/types$': '<rootDir>/../../packages/types/src/index.ts' },
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
  testEnvironment: 'node',
  testTimeout: 60_000,
};

export default config;
