import { Address, beginCell, Cell } from '@ton/core';
import { buildPlan, envBlock, DEFAULT_CONFIG, DEMO_CONFIG, GOVERNED_CONFIG, PlanInput } from '../scripts/stonpoolPlan';

const admin = Address.parseRaw('0:' + '11'.repeat(32));
const minter = Address.parseRaw('0:' + '22'.repeat(32));

const code = (tag: number): Cell => beginCell().storeUint(tag, 32).endCell();
const codes = {
  poolCore: code(1), adapter: code(2), vault: code(3), drawEngine: code(4),
  governor: code(5), router: code(6), stonfiPool: code(7), wallet: code(8),
};

const input = (demo: boolean): PlanInput => ({ admin, minter, genesis: 1_700_000_000, epoch: 1, demo, codes });

describe('stonpool deploy plan', () => {
  it('demo preset shortens every window vs default', () => {
    expect(DEMO_CONFIG.epochLength).toBeLessThan(DEFAULT_CONFIG.epochLength);
    expect(DEMO_CONFIG.depositCutoff).toBeLessThan(DEFAULT_CONFIG.depositCutoff);
    expect(DEMO_CONFIG.commitWindow).toBeLessThan(DEFAULT_CONFIG.commitWindow);
    expect(DEMO_CONFIG.revealWindow).toBeLessThan(DEFAULT_CONFIG.revealWindow);
  });

  // Mirrors isValidConfig in contracts/param_governor.tolk. The governor rejects an
  // invalid proposal on-chain, but that costs a testnet round trip to discover; this
  // catches it here instead. MAX_PRIZE_TIERS is 8 (contracts/gas.tolk).
  it('governed config satisfies every governor constraint', () => {
    const c = GOVERNED_CONFIG;
    expect(c.epochLength).not.toBe(0);
    expect(c.commitWindow).not.toBe(0);
    expect(c.revealWindow).not.toBe(0);
    expect(c.prizeTiers).not.toBe(0);
    expect(c.prizeTiers).toBeLessThanOrEqual(8);
    expect(c.skimBps).toBeLessThanOrEqual(10000);
    expect(c.depositCutoff).toBeLessThanOrEqual(c.epochLength);
    expect(c.commitWindow + c.revealWindow).toBeLessThanOrEqual(c.epochLength);
  });

  // The slack between the draw windows and the epoch is the orphan margin: if a draw has
  // not settled when the next advance lands, the advance throws ERR_BUSY. Keep it wide
  // enough that the keeper has many poll cycles to settle in.
  it('governed config speeds up the cycle while keeping orphan margin', () => {
    const g = GOVERNED_CONFIG;
    const cycle = (c: typeof g) => c.epochLength + c.commitWindow + c.revealWindow;
    expect(cycle(g)).toBeLessThan(cycle(DEMO_CONFIG));
    expect(g.epochLength - (g.commitWindow + g.revealWindow)).toBeGreaterThanOrEqual(90);
    expect(g.minHoldEpochs).toBe(DEMO_CONFIG.minHoldEpochs); // product property, unchanged
  });

  it('is deterministic for identical inputs', () => {
    const a = buildPlan(input(false));
    const b = buildPlan(input(false));
    expect(a.core.poolCore.equals(b.core.poolCore)).toBe(true);
    expect(a.wallets.adapterLpWallet.equals(b.wallets.adapterLpWallet)).toBe(true);
  });

  it('assigns distinct addresses to every core contract', () => {
    const { core } = buildPlan(input(false));
    const all = Object.values(core).map((a) => a.toRawString());
    expect(new Set(all).size).toBe(all.length);
  });

  it("derives the adapter LP wallet from the stonfi pool, not the underlying minter", () => {
    const p = buildPlan(input(false));
    expect(p.wallets.adapterLpWallet.equals(p.wallets.adapterWallet)).toBe(false);
  });

  it('demo and default deploy to different pool-core addresses', () => {
    expect(buildPlan(input(true)).core.poolCore.equals(buildPlan(input(false)).core.poolCore)).toBe(false);
  });

  it('emits both env scopes with the deployed addresses', () => {
    const p = buildPlan(input(false));
    const env = envBlock(minter, p);
    expect(env).toContain(`STONPOOL_POOL_CORE_ADDRESS=${p.core.poolCore.toRawString()}`);
    expect(env).toContain(`VITE_POOL_CORE_ADDRESS=${p.core.poolCore.toRawString()}`);
    expect(env).toContain(`STONPOOL_JETTON_MASTER_ADDRESS=${minter.toRawString()}`);
    expect(env).toContain(`VITE_JETTON_MINTER_ADDRESS=${minter.toRawString()}`);
    expect(env).toContain(`STONPOOL_ADAPTER_ADDRESS=${p.core.adapter.toRawString()}`);
  });
});