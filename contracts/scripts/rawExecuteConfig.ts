import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, internal, toNano, SendMode } from '@ton/core';
import { PoolConfig } from '../wrappers/protocol';
import { GOVERNED_CONFIG } from './stonpoolPlan';

// Stage 3 step 2: apply the staged config once the timelock has elapsed, then prove it
// landed on BOTH the governor and pool-core. That second check is the point: the governor
// forwards ParamsUpdated NoBounce, so if pool-core's ROLE_GOVERNOR does not match this
// governor it rejects with 401 and the governor never finds out - the governor would read
// as updated while pool-core silently kept the old config.

const OP_EXECUTE = 0x10000042;

function envVar(env: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`);
  const hits = env.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter((v): v is string => !!v);
  return hits[hits.length - 1]?.replace(/^["']|["']$/g, '');
}

const explain = (e: any): string => {
  const d = e?.response?.data;
  return d?.error ? `${e.response.status} ${d.error}` : (e?.message ?? String(e));
};

const isTransient = (e: any) =>
  e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' ||
  /timeout|socket hang up|network|EAI_AGAIN/i.test(e?.message ?? '') ||
  e?.response?.status === 429 || e?.response?.status >= 500;

async function rpc<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!isTransient(e) || i >= tries) throw e;
      console.log(`  retry ${i}/${tries - 1} ${label}: ${(e as any)?.code ?? (e as any)?.message}`);
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
}

function unpackConfig(cell: Cell): PoolConfig {
  const s = cell.beginParse();
  return {
    epochLength: s.loadUint(32), depositCutoff: s.loadUint(32),
    commitWindow: s.loadUint(32), revealWindow: s.loadUint(32),
    minHoldEpochs: s.loadUint(16), prizeTiers: s.loadUint(8),
    skimBps: s.loadUint(16), drawBond: s.loadCoins(),
  };
}

const show = (c: PoolConfig) =>
  `epoch=${c.epochLength} cutoff=${c.depositCutoff} commit=${c.commitWindow} reveal=${c.revealWindow} ` +
  `minHold=${c.minHoldEpochs} tiers=${c.prizeTiers} skim=${c.skimBps} bond=${c.drawBond}`;

const same = (a: PoolConfig, b: PoolConfig) =>
  a.epochLength === b.epochLength && a.depositCutoff === b.depositCutoff &&
  a.commitWindow === b.commitWindow && a.revealWindow === b.revealWindow &&
  a.minHoldEpochs === b.minHoldEpochs && a.prizeTiers === b.prizeTiers &&
  a.skimBps === b.skimBps && a.drawBond === b.drawBond;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));
  const governor = Address.parseRaw(reg.governor);
  const poolCore = Address.parseRaw(reg.poolCore);

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));

  const gov = async () => {
    const s = (await rpc('get_governor_data', () => c.runMethod(governor, 'get_governor_data'))).stack;
    s.readAddress(); s.readAddress(); const timelock = Number(s.readBigNumber());
    return { timelock, executeAfter: Number(s.readBigNumber()) };
  };
  const pendingCfg = async (): Promise<PoolConfig | null> => {
    const s = (await rpc('get_pending', () => c.runMethod(governor, 'get_pending'))).stack;
    const cell = s.readCellOpt();
    return cell ? unpackConfig(cell) : null;
  };
  const cfgOf = async (addr: Address): Promise<PoolConfig> =>
    unpackConfig((await rpc('get_config', () => c.runMethod(addr, 'get_config'))).stack.readCell());

  console.log('governor ', governor.toString({ testOnly: true }));
  console.log('poolCore ', poolCore.toString({ testOnly: true }));
  console.log('live now ', show(await cfgOf(poolCore)));

  const staged = await pendingCfg();
  const { executeAfter } = await gov();
  if (!staged || executeAfter === 0) {
    console.error('nothing staged - run scripts/rawProposeConfig.ts first');
    process.exit(1);
  }
  console.log('staged   ', show(staged));
  if (!same(staged, GOVERNED_CONFIG)) {
    console.error('WARNING: staged config differs from GOVERNED_CONFIG in stonpoolPlan.ts');
  }

  // timelock gate: executing early throws ERR_TIMELOCK_ACTIVE (440) and wastes a round trip
  for (;;) {
    const wait = executeAfter - Math.floor(Date.now() / 1000);
    if (wait <= 0) break;
    console.log(`timelock: ${wait}s remaining`);
    await sleep(Math.min(wait, 15) * 1000);
  }

  console.log('> execute');
  const prev = await rpc('seqno', () => w.getSeqno());
  await w.sendTransfer({
    seqno: prev, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: governor, value: toNano('0.2'), body: beginCell().storeUint(OP_EXECUTE, 32).storeUint(0, 64).endCell(), bounce: true })],
  });
  for (let i = 0; i < 40; i++) {
    await sleep(3000);
    if (await rpc('confirm', () => w.getSeqno()) > prev) break;
  }

  // governor side: pending cleared and the new config active
  let govOk = false;
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    const g = await gov();
    if (g.executeAfter === 0 && (await pendingCfg()) === null) { govOk = true; break; }
  }

  // pool-core side: the ParamsUpdated forward actually applied. This is the check that
  // catches a mis-wired ROLE_GOVERNOR, which fails silently because the send is NoBounce.
  let live = await cfgOf(poolCore);
  for (let i = 0; i < 20 && !same(live, staged); i++) {
    await sleep(3000);
    live = await cfgOf(poolCore);
  }

  console.log(`governor applied : ${govOk ? 'PASS' : 'FAIL'}`);
  console.log(`pool-core applied: ${same(live, staged) ? 'PASS' : 'FAIL'}`);
  console.log('live now ', show(live));

  if (!govOk || !same(live, staged)) {
    console.error('\nconfig did not fully apply.');
    console.error('if the governor shows applied but pool-core does not, pool-core ROLE_GOVERNOR is not this governor');
    console.error('(the ParamsUpdated send is NoBounce, so the governor cannot detect that).');
    process.exit(1);
  }
  console.log('\nnew timings take effect at the next AdvanceEpoch (ParamsUpdated does not recompute depositDeadline)');
}

main().catch((e) => { console.error('execute failed:', explain(e)); process.exit(1); });