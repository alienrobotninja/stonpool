import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, internal, toNano, SendMode } from '@ton/core';
import { commitHashOf, buildCommit, buildReveal } from './demo';

// Drives one full cycle: advance -> commit -> reveal -> settle, printing the finalized
// seed and the resulting pot. Timings come from pool-core's get_config, never from a local
// constant: the governor can change them at any time and a stale copy mistimes the advance.

const OP_ADVANCE = 0x10000004, OP_SETTLE = 0x10000016;
const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)[1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
const now = () => Math.floor(Date.now() / 1000);
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

// layout mirrors packConfig in wrappers/protocol.ts
function unpackConfig(cell: Cell) {
  const s = cell.beginParse();
  return {
    epochLength: s.loadUint(32), depositCutoff: s.loadUint(32),
    commitWindow: s.loadUint(32), revealWindow: s.loadUint(32),
    minHoldEpochs: s.loadUint(16), prizeTiers: s.loadUint(8),
    skimBps: s.loadUint(16), drawBond: s.loadCoins(),
  };
}

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const pool = Address.parse(reg.poolCore);
  const draw = Address.parse(reg.drawEngine);

  const send = async (to, value, body) => {
    const s = await w.getSeqno();
    await w.sendTransfer({ seqno: s, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY, messages: [internal({ to, value, body, bounce: false })] });
    for (let i = 0; i < 40; i++) { await sleep(3); if (await w.getSeqno() > s) return; }
    throw new Error('seqno stuck');
  };
  const phase = async () => Number((await c.runMethod(draw, 'get_phase')).stack.readNumber());
  const waitPhase = async (target, max = 200) => {
    for (let i = 0; i < max; i++) { const p = await phase(); console.log('  phase', p); if (p === target) return; await sleep(6); }
    throw new Error('phase never reached ' + target);
  };

  const cfg = unpackConfig((await c.runMethod(pool, 'get_config')).stack.readCell());
  console.log('config epoch', cfg.epochLength, 'cutoff', cfg.depositCutoff, 'commit', cfg.commitWindow, 'reveal', cfg.revealWindow);
  // The draw-engine runs the windows and bond it was DEPLOYED with; pool-core's config is
  // not forwarded to it and it exposes no bond getter. Both were seeded from the same preset,
  // so the governed drawBond matches - and if they ever diverge the commit fails loudly with
  // ERR_INSUFFICIENT_BOND rather than silently overpaying every cycle.
  const bond = cfg.drawBond;

  const pd = await c.runMethod(pool, 'get_pool_data');
  pd.stack.readBigNumber();
  const deadline = Number(pd.stack.readBigNumber());
  const epochEnd = deadline + cfg.depositCutoff;
  const wait = epochEnd - now() + 5;
  if (wait > 0) { console.log('waiting', wait, 's for epoch end'); await sleep(wait); }

  console.log('advance epoch'); await send(pool, toNano('1'), beginCell().storeUint(OP_ADVANCE, 32).storeUint(0, 64).endCell());
  console.log('await commit window'); await waitPhase(1);

  const secret = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(31))].map(b => b.toString(16).padStart(2, '0')).join(''));
  console.log('commit'); await send(draw, bond + toNano('0.1'), buildCommit(commitHashOf(secret)));
  console.log('await reveal window'); await waitPhase(2);
  console.log('reveal'); await send(draw, toNano('0.1'), buildReveal(secret));
  console.log('await finalize-ready'); await waitPhase(3);
  console.log('settle'); await send(pool, toNano('0.3'), beginCell().storeUint(OP_SETTLE, 32).storeUint(0, 64).endCell());

  const ds = await c.runMethod(draw, 'get_draw_state');
  const ep = ds.stack.readBigNumber(); ds.stack.readBigNumber(); ds.stack.readBigNumber(); ds.stack.readBoolean();
  console.log('DRAW FINALIZED epoch', ep.toString(), 'seed', ds.stack.readBigNumber().toString(16));
  const p2 = await c.runMethod(pool, 'get_pool_data'); p2.stack.readBigNumber(); p2.stack.readBigNumber(); p2.stack.readBigNumber();
  console.log('prizePot', p2.stack.readBigNumber().toString());
}
main();