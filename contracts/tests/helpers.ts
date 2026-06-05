import { Cell } from '@ton/core';
import { readFileSync } from 'fs';
import { resolve } from 'path';

export const BUILD_DIR = resolve(__dirname, '..', 'build', 'test');

// Reads code compiled once in globalSetup. Keeps the Tolk wasm compiler out of
// the test workers (faster, and avoids the worker-exit leak it caused).
export function loadCode(name: string): Cell {
  return Cell.fromBase64(readFileSync(resolve(BUILD_DIR, `${name}.boc.b64`), 'utf-8'));
}