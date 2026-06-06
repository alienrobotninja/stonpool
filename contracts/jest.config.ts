import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};

export default config;