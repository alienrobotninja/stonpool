import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Address, beginCell, Cell } from '@ton/core';
import { buildPlan, PlanInput } from '../scripts/stonpoolPlan';
import { buildRegistry, loadRegistry, registryPath, writeRegistry } from '../scripts/addresses';

const admin = Address.parseRaw('0:' + '11'.repeat(32));
const minter = Address.parseRaw('0:' + '22'.repeat(32));
const code = (tag: number): Cell => beginCell().storeUint(tag, 32).endCell();
const input: PlanInput = {
  admin, minter, genesis: 1_700_000_000, epoch: 1, demo: false,
  codes: { poolCore: code(1), adapter: code(2), vault: code(3), drawEngine: code(4), governor: code(5), router: code(6), stonfiPool: code(7), wallet: code(8) },
};

describe('address registry', () => {
  it('captures every deployed address in raw form', () => {
    const plan = buildPlan(input);
    const reg = buildRegistry('testnet', minter, plan);
    expect(reg.network).toBe('testnet');
    expect(reg.jettonMinter).toBe(minter.toRawString());
    expect(reg.poolCore).toBe(plan.core.poolCore.toRawString());
    expect(reg.wallets.adapterLp).toBe(plan.wallets.adapterLpWallet.toRawString());
    // no friendly/bounceable ambiguity: raw only
    expect(reg.adapter.startsWith('0:')).toBe(true);
  });

  it('round-trips through disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stonpool-reg-'));
    const plan = buildPlan(input);
    const path = writeRegistry('testnet', minter, plan, dir);
    expect(path).toBe(registryPath('testnet', dir));
    expect(loadRegistry('testnet', dir)).toEqual(buildRegistry('testnet', minter, plan));
  });
});