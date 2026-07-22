import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/tests/globalSetup.js',
  testPathIgnorePatterns: ['/node_modules/', '/dist/'],
  // Each test stands up a sandbox Blockchain, deploys several contracts and sends many
  // messages; the heaviest setup runs ~1.5s idle but 5-10x that on a contended runInBand
  // run, which blew past jest's 5000ms default. 30s kills that flake without hiding a hang.
  testTimeout: 30_000,
};

export default config;