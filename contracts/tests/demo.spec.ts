import { Address, toNano } from '@ton/core';
import {
  buildAdvanceEpoch, buildCommit, buildDeposit, buildFaucetClaim, buildHarvest, buildReveal,
  buildSettleDraw, buildTransfer, commitHashOf, depositSchedule, harvestAmounts, mixSeed,
} from '../scripts/demo';
import { OP } from '../wrappers/protocol';

const pool = Address.parseRaw('0:' + '22'.repeat(32));
const user = Address.parseRaw('0:' + '33'.repeat(32));
const vault = Address.parseRaw('0:' + '44'.repeat(32));

describe('demo helpers', () => {
  it('commit hash and seed mixing match the on-chain vectors the keeper pins', () => {
    // identical constants to backend tests/test_keeper.py (byte-equal vs the contract)
    expect(commitHashOf(12345n)).toBe(0x72f82454b583f5ef1f6e84b3507bdebc893c959cdd3fe47b64f2889ad99fe86dn);
    expect(mixSeed(0n, 12345n)).toBe(0xe981ea86bffd389f82477c4d7df495abf4fa12030d3fe1276cb1276b6ac1449en);
  });

  it('faucet claim body carries the request op', () => {
    const s = buildFaucetClaim(7n).beginParse();
    expect(s.loadUint(32)).toBe(OP.FAUCET_REQUEST);
    expect(s.loadUintBig(64)).toBe(7n);
  });

  it('deposit body routes to the pool with the inline deposit-forward payload', () => {
    const s = buildDeposit({ amount: 1000n, pool, user, forwardTon: toNano('0.6') }).beginParse();
    expect(s.loadUint(32)).toBe(OP.TRANSFER);
    s.loadUintBig(64);
    expect(s.loadCoins()).toBe(1000n);
    expect(s.loadAddress().equals(pool)).toBe(true);
    expect(s.loadAddress().equals(user)).toBe(true); // response/excess
    expect(s.loadMaybeRef()).toBeNull();
    expect(s.loadCoins()).toBe(toNano('0.6'));
    expect(s.loadUint(32)).toBe(OP.DEPOSIT); // inline forward payload
    expect(s.loadAddress().equals(user)).toBe(true);
  });

  it('plain transfer has recipient and no forward payload', () => {
    const router = Address.parseRaw('0:' + '55'.repeat(32));
    const s = buildTransfer({ amount: 500n, to: router, responseTo: user, forwardTon: 0n }).beginParse();
    expect(s.loadUint(32)).toBe(OP.TRANSFER);
    s.loadUintBig(64);
    expect(s.loadCoins()).toBe(500n);
    expect(s.loadAddress().equals(router)).toBe(true);
    expect(s.loadAddress().equals(user)).toBe(true);
    expect(s.loadMaybeRef()).toBeNull();
    expect(s.loadCoins()).toBe(0n);
    expect(s.remainingBits).toBe(0); // nothing trails the forward-ton amount
  });

  it('harvest body carries burn, gross and the vault sink', () => {
    const s = buildHarvest(500n, 650n, vault).beginParse();
    expect(s.loadUint(32)).toBe(OP.HARVEST_STONFI);
    s.loadUintBig(64);
    expect(s.loadCoins()).toBe(500n);
    expect(s.loadCoins()).toBe(650n);
    expect(s.loadAddress().equals(vault)).toBe(true);
  });

  it('commit/reveal/advance/settle bodies parse back', () => {
    const c = buildCommit(99n).beginParse();
    expect(c.loadUint(32)).toBe(OP.COMMIT); c.loadUintBig(64); expect(c.loadUintBig(256)).toBe(99n);
    const r = buildReveal(123n).beginParse();
    expect(r.loadUint(32)).toBe(OP.REVEAL); r.loadUintBig(64); expect(r.loadUintBig(256)).toBe(123n);
    expect(buildAdvanceEpoch().beginParse().loadUint(32)).toBe(OP.ADVANCE_EPOCH);
    expect(buildSettleDraw().beginParse().loadUint(32)).toBe(OP.SETTLE_DRAW);
  });

  it('harvest math mirrors the keeper: integer burn, recomputed gross', () => {
    // principal 10000, lp 10000, reserve 13000/supply 10000 -> lpValue 13000, accrued 3000
    const { lpToBurn, gross } = harvestAmounts({ principal: 10000n, lpBalance: 10000n }, { reserve: 13000n, lpSupply: 10000n });
    expect(lpToBurn).toBe(2307n); // 3000*10000/13000 floored
    expect(gross).toBe(2999n); // 2307*13000/10000 floored
    expect(harvestAmounts({ principal: 10000n, lpBalance: 10000n }, { reserve: 10000n, lpSupply: 10000n })).toEqual({ lpToBurn: 0n, gross: 0n });
  });

  it('deposit schedule is varied and scaled to 6 decimals', () => {
    const s = depositSchedule(3);
    expect(s).toEqual([400n * 10n ** 6n, 1000n * 10n ** 6n, 700n * 10n ** 6n]);
  });
});