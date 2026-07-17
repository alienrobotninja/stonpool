import { Blockchain } from '@ton/sandbox';
import { beginCell, Address } from '@ton/core';
import '@ton/test-utils';
import { packConfig, poolSetup } from '../wrappers/protocol';
import { poolCoreData } from '../wrappers/PoolCore';

// The guard that makes the shared builder safe to depend on. Every distinct pool-storage
// fixture shape in the suite, built the old inline way and via poolCoreData(). Identical
// hashes mean the two are interchangeable, so a spec on the shared builder is testing the
// same contract state it always was.
//
// This exists because the alternative is trusting a green suite: a fixture can drift far
// enough to change behaviour while every assertion still passes, since most specs deposit
// at bc.now = T0 and never approach their deadline. Hashes catch what assertions cannot.
const T0 = 1_000_000;
const inline = (epoch: number, deadline: number, genesis: number, admin: Address, cfg: any) =>
  beginCell().storeUint(epoch, 32).storeUint(deadline, 32).storeUint(genesis, 32)
    .storeCoins(0).storeCoins(0).storeBit(false).storeUint(0, 64).storeAddress(admin)
    .storeRef(poolSetup(packConfig(cfg))).storeBit(false).storeBit(false).endCell();

it('poolCoreData reproduces every inline fixture byte-for-byte', async () => {
  const bc = await Blockchain.create();
  const admin = (await bc.treasury('admin')).address;
  const c86 = { epochLength: 86400, depositCutoff: 3600, commitWindow: 1800, revealWindow: 1800, minHoldEpochs: 0, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };
  const cEpoch = { epochLength: 3600, depositCutoff: 600, commitWindow: 900, revealWindow: 900, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };

  const cases: Array<[string, ReturnType<typeof inline>, ReturnType<typeof poolCoreData>]> = [
    ['flat deadline (withdraw/deposit/hardening/payout)',
      inline(5, T0 + 100_000, T0, admin, c86),
      poolCoreData({ epoch: 5, genesis: T0, admin, config: c86, depositDeadline: T0 + 100_000 })],
    ['derived deadline (epoch/e2e/initdata/stonfi)',
      inline(5, T0 + 3600 - 600, T0, admin, cEpoch),
      poolCoreData({ epoch: 5, genesis: T0, admin, config: cEpoch })],
    ['derived, 86400 config',
      inline(5, T0 + 86400 - 3600, T0, admin, c86),
      poolCoreData({ epoch: 5, genesis: T0, admin, config: c86 })],
  ];
  for (const [label, a, b] of cases) {
    console.log(`${a.hash().equals(b.hash()) ? 'MATCH  ' : 'DIFFER '} ${label}`);
    expect(a.hash().toString('hex')).toBe(b.hash().toString('hex'));
  }
});