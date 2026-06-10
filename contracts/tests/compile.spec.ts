import { existsSync, statSync } from 'fs';
import { resolve } from 'path';
import { BUILD_DIR } from './helpers';

// globalSetup compiles every entrypoint once and fails the run on any Tolk error,
// so it is the compile gate. This just confirms each artifact was produced.
describe('Tolk build artifacts', () => {
  it.each(['wallet', 'minter', 'faucet', 'shared_tester', 'iface_tester', 'messaging_tester', 'mock_adapter', 'draw_selection_tester', 'selection_tester', 'draw_engine', 'param_governor', 'jetton_vault', 'pool_core', 'mock_stonfi_router', 'mock_stonfi_pool', 'mock_stonfi_tester'])(
    '%s.boc.b64 exists and is non-empty',
    (name) => {
      const p = resolve(BUILD_DIR, `${name}.boc.b64`);
      expect(existsSync(p)).toBe(true);
      expect(statSync(p).size).toBeGreaterThan(0);
    },
  );
});