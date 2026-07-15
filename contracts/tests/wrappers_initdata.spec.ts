import { Address, beginCell, Cell, toNano } from '@ton/core';
import { PoolCore } from '../wrappers/PoolCore';
import { JettonVault } from '../wrappers/JettonVault';
import { YieldAdapterStonfi } from '../wrappers/YieldAdapterStonfi';
import { DrawEngine } from '../wrappers/DrawEngine';
import { ParamGovernor } from '../wrappers/ParamGovernor';
import { MockStonfiRouter } from '../wrappers/MockStonfiRouter';
import { MockStonfiPool } from '../wrappers/MockStonfiPool';
import { packConfig, PoolConfig } from '../wrappers/protocol';

// Same constants the sandbox lifecycle specs deploy with. The wrappers must reproduce
// these init-data cells byte-for-byte, or a testnet deploy lands a contract whose storage
// the on-chain code can't read back.
const T0 = 1_000_000;
const EPOCH = 5, EPOCH_LENGTH = 3600, DEPOSIT_CUTOFF = 600;
const COMMIT_WINDOW = 900, REVEAL_WINDOW = 900, DRAW_BOND = toNano('1');
const CFG: PoolConfig = {
  epochLength: EPOCH_LENGTH, depositCutoff: DEPOSIT_CUTOFF, commitWindow: COMMIT_WINDOW,
  revealWindow: REVEAL_WINDOW, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1000, drawBond: DRAW_BOND,
};

const admin = Address.parseRaw('0:' + '11'.repeat(32));
const pool = Address.parseRaw('0:' + '22'.repeat(32));
const walletCode = beginCell().storeUint(0xc0de, 16).endCell();
const code = beginCell().endCell();

const data = (c: { init?: { data: Cell } }) => c.init!.data;

describe('deploy wrappers reproduce the sandbox init-data byte-for-byte', () => {
  it('pool-core', () => {
    const inline = beginCell()
      .storeUint(EPOCH, 32).storeUint(T0 + EPOCH_LENGTH - DEPOSIT_CUTOFF, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0).storeBit(false).storeAddress(admin).storeRef(packConfig(CFG)).storeBit(false).storeBit(false)
      .endCell();
    const w = PoolCore.createFromConfig({ epoch: EPOCH, genesis: T0, admin, config: CFG }, code);
    expect(data(w).equals(inline)).toBe(true);
  });

  it('jetton-vault', () => {
    const inline = beginCell().storeAddress(admin).storeAddress(null).storeAddress(null).storeCoins(0).endCell();
    expect(data(JettonVault.createFromConfig(admin, code)).equals(inline)).toBe(true);
  });

  it('yield-adapter-stonfi', () => {
    const inline = beginCell().storeAddress(admin).storeCoins(0).storeCoins(0).storeUint(0, 16).storeBit(false).endCell();
    expect(data(YieldAdapterStonfi.createFromConfig(admin, code)).equals(inline)).toBe(true);
  });

  it('draw-engine', () => {
    const inline = beginCell()
      .storeAddress(pool).storeUint(0, 32).storeUint(COMMIT_WINDOW, 32).storeUint(REVEAL_WINDOW, 32).storeCoins(DRAW_BOND)
      .storeUint(0, 32).storeUint(0, 32).storeBit(false).storeUint(0, 256).storeBit(false)
      .endCell();
    const w = DrawEngine.createFromConfig({ poolCore: pool, commitWindow: COMMIT_WINDOW, revealWindow: REVEAL_WINDOW, drawBond: DRAW_BOND }, code);
    expect(data(w).equals(inline)).toBe(true);
  });

  it('param-governor', () => {
    const inline = beginCell()
      .storeAddress(admin).storeAddress(pool).storeUint(3600, 32).storeUint(0, 32).storeRef(packConfig(CFG)).storeMaybeRef(null)
      .endCell();
    const w = ParamGovernor.createFromConfig({ admin, poolCore: pool, timelockDelay: 3600, config: CFG }, code);
    expect(data(w).equals(inline)).toBe(true);
  });

  it('mock-stonfi-router', () => {
    const inline = beginCell().storeAddress(admin).storeAddress(null).storeAddress(null).endCell();
    expect(data(MockStonfiRouter.createFromConfig(admin, code)).equals(inline)).toBe(true);
  });

  it('mock-stonfi-pool', () => {
    const inline = beginCell().storeAddress(admin).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell();
    expect(data(MockStonfiPool.createFromConfig(admin, walletCode, code)).equals(inline)).toBe(true);
  });
});