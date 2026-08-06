import { Address, beginCell, Cell, contractAddress } from '@ton/core';
import { jettonVaultData } from '../wrappers/JettonVault';
import { mockStonfiPoolData } from '../wrappers/MockStonfiPool';
import { mockStonfiRouterData } from '../wrappers/MockStonfiRouter';

// The deployer skips whatever is already active at a computed address. Before genesis
// reached these three their init data was identical run to run, so a redeploy adopted the
// previous vault, router and venue and inherited their balances. A venue carrying the last
// run's reserve and lpSupply shares every later yield injection with LP held by a dead
// adapter, and the loss is invisible: the quote is read off-chain and looks self-consistent.
const admin = Address.parseRaw('0:' + '11'.repeat(32));
const code = beginCell().storeUint(0xc0de, 16).endCell();
const walletCode = beginCell().storeUint(0xbeef, 16).endCell();

const A = 1_700_000_000;
const B = A + 1;

const addr = (data: Cell) => contractAddress(0, { code, data }).toRawString();

describe('every deployed contract is scoped to its deployment', () => {
  it('moves the address when genesis moves', () => {
    expect(addr(jettonVaultData(admin, A))).not.toBe(addr(jettonVaultData(admin, B)));
    expect(addr(mockStonfiRouterData(admin, A))).not.toBe(addr(mockStonfiRouterData(admin, B)));
    expect(addr(mockStonfiPoolData(admin, walletCode, A)))
      .not.toBe(addr(mockStonfiPoolData(admin, walletCode, B)));
  });

  // a rerun after a mid-deploy timeout has to land on the same addresses, or it orphans
  // whatever the first attempt already deployed
  it('stays deterministic within one deployment', () => {
    expect(addr(jettonVaultData(admin, A))).toBe(addr(jettonVaultData(admin, A)));
    expect(addr(mockStonfiRouterData(admin, A))).toBe(addr(mockStonfiRouterData(admin, A)));
    expect(addr(mockStonfiPoolData(admin, walletCode, A)))
      .toBe(addr(mockStonfiPoolData(admin, walletCode, A)));
  });

  it('carries the stamp as a fixed-width field rather than reshaping the cell', () => {
    for (const [x, y] of [
      [jettonVaultData(admin, A), jettonVaultData(admin, B)],
      [mockStonfiRouterData(admin, A), mockStonfiRouterData(admin, B)],
      [mockStonfiPoolData(admin, walletCode, A), mockStonfiPoolData(admin, walletCode, B)],
    ]) {
      expect(x.bits.length).toBe(y.bits.length);
      expect(x.refs.length).toBe(y.refs.length);
      expect(x.equals(y)).toBe(false);
    }
  });
});