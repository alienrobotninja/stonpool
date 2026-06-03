import { runTolkCompiler } from '@ton/tolk-js';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');

// Each tester imports its production module(s), so compiling these entrypoints
// is the smoke test for shared, yield_adapter_iface, and messaging.
async function compile(entry: string) {
  return runTolkCompiler({
    entrypointFileName: entry,
    fsReadCallback: (p) => readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
  });
}

describe('Tolk compile smoke', () => {
  it.each(['shared_tester.tolk', 'iface_tester.tolk', 'messaging_tester.tolk'])(
    '%s compiles cleanly',
    async (entry) => {
      const res = await compile(entry);
      if (res.status !== 'ok') throw new Error(`${entry}:\n${res.message}`);
      expect(res.status).toBe('ok');
    },
    30000,
  );
});