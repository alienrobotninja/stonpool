const { runTolkCompiler } = require('@ton/tolk-js');
const { mkdirSync, writeFileSync, readFileSync } = require('fs');
const { dirname, join, resolve } = require('path');

const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');
const BUILD_DIR = resolve(__dirname, '..', 'build', 'test');
const STDLIB_DIR = join(dirname(require.resolve('@ton/tolk-js')), 'tolk-stdlib');

const TARGETS = {
  wallet: 'mock-jetton/jetton-wallet.tolk',
  minter: 'mock-jetton/jetton-minter.tolk',
  faucet: 'mock-jetton/faucet.tolk',
  shared_tester: 'shared_tester.tolk',
  iface_tester: 'iface_tester.tolk',
  messaging_tester: 'messaging_tester.tolk',
  mock_adapter: 'yield_adapter_mock.tolk',
  draw_selection_tester: 'draw_selection_tester.tolk',
  selection_tester: 'selection_tester.tolk',
  draw_engine: 'draw_engine.tolk',
  param_governor: 'param_governor.tolk',
  jetton_vault: 'jetton_vault.tolk',
  pool_core: 'pool_core.tolk',
};

module.exports = async () => {
  mkdirSync(BUILD_DIR, { recursive: true });
  for (const [name, entry] of Object.entries(TARGETS)) {
    const res = await runTolkCompiler({
      entrypointFileName: entry,
      fsReadCallback: (p) =>
        p.startsWith('@stdlib/')
          ? readFileSync(join(STDLIB_DIR, p.slice('@stdlib/'.length) + '.tolk'), 'utf-8')
          : readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
    });
    if (res.status !== 'ok') throw new Error(`compile ${entry}:\n${res.message}`);
    writeFileSync(join(BUILD_DIR, `${name}.boc.b64`), res.codeBoc64);
  }
};