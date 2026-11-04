import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testRegex: '\\.integration\\.spec\\.ts$',
  globalSetup: '<rootDir>/src/testing/integration-setup.ts',
  globalTeardown: '<rootDir>/src/testing/integration-teardown.ts',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
};

export default config;
