import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, beginCell, internal, toNano, SendMode } from '@ton/core';
import { packConfig, PoolConfig } from '../wrappers/protocol';
import { GOVERNED_CONFIG } from './stonpoolPlan';

// Stage 3 step 1: propose GOVERNED_CONFIG to the param-governor. This only stages it -
// it becomes live after the timelock, applied by rawExecuteConfig. The governor swaps the
// config cell without recomputing depositDeadline, so the new timings take effect at the
// next AdvanceEpoch, not on apply.

const OP_PROPOSE = 0x10000041;

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

// mirrors isValidConfig in contracts/param_governor.tolk; fail here rather than burn a
// testnet round trip discovering it
function assertValid(c: PoolConfig) {
  const bad: string[] = [];
  if (!c.epochLength) bad.push('epochLength == 0');
  if (!c.commitWindow) bad.push('commitWindow == 0');
  if (!c.revealWindow) bad.push('revealWindow == 0');
  if (!c.prizeTiers) bad.push('prizeTiers == 0');
  if (c.prizeTiers > 8) bad.push('prizeTiers > MAX_PRIZE_TIERS(8)');
  if (c.skimBps > 10000) bad.push('skimBps > 10000');
  if (c.depositCutoff > c.epochLength) bad.push('depositCutoff > epochLength');
  if (c.commitWindow + c.revealWindow > c.epochLength) bad.push('commitWindow + revealWindow > epochLength');
  if (bad.length) { console.error('config rejected locally:', bad.join('; ')); process.exit(1); }
}

async function main() {
  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));
  const governor = Address.parseRaw(reg.governor);

  const cfg = GOVERNED_CONFIG;
  assertValid(cfg);

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));

  console.log('governor', governor.toString({ testOnly: true }));
  console.log('proposing', JSON.stringify({ ...cfg, drawBond: cfg.drawBond.toString() }));

  const body = beginCell().storeUint(OP_PROPOSE, 32).storeUint(0, 64)
    .storeSlice(packConfig(cfg).beginParse()).endCell();

  const prev = await rpc('seqno', () => w.getSeqno());
  await w.sendTransfer({
    seqno: prev, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: governor, value: toNano('0.1'), body, bounce: true })],
  });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    if (await rpc('confirm', () => w.getSeqno()) > prev) break;
  }

  // read back: a rejected proposal leaves pending null, which is the failure signal
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const st = (await rpc('get_governor_data', () => c.runMethod(governor, 'get_governor_data'))).stack;
    st.readAddress(); st.readAddress(); st.readBigNumber();
    const executeAfter = Number(st.readBigNumber());
    if (executeAfter > 0) {
      const now = Math.floor(Date.now() / 1000);
      console.log(`staged. executeAfter=${executeAfter} (in ${Math.max(0, executeAfter - now)}s)`);
      console.log('next: npx tsx scripts/rawExecuteConfig.ts');
      return;
    }
  }
  console.error('nothing staged - the governor rejected the proposal or the send did not land');
  process.exit(1);
}

main().catch((e) => { console.error('propose failed:', explain(e)); process.exit(1); });