import { Address, beginCell, Cell } from '@ton/core';
import { buildPlan, envBlock, DEFAULT_CONFIG, DEMO_CONFIG, PlanInput } from '../scripts/stonpoolPlan';

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