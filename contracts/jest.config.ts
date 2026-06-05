import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  forceExit: true, // sandbox emulator leaves a handle open; standard for @ton/sandbox suites
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
};

export default config;