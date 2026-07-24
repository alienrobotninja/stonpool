import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { walletData } from '../wrappers/mockStack';
import { derivePlayers, UNIT, WEIGHTS } from './demoPlayers';

// Seeds a field of depositors from ONE funded wallet. pool-core lets a deposit name its
// beneficiary in the forward payload (pool_core.tolk: beneficiary defaults to msg.sender,
// an OP_DEPOSIT payload overrides it), so the operator pays gas and jettons while each
// position is credited to a different address. Players are operator subwallets, so their
// keys are held and any of them can withdraw later to demonstrate no-loss.
//
// Weights are deliberately uneven: odds are weight-proportional, and a field of equal
// stakes shows nothing. Sizing is small on purpose - the faucet drips 1000 jUSDT per
// address per hour and cannot mint to anyone but the claimer, so the whole demo has to
// fit inside one claim with room left for the yield injection.

const OP_TRANSFER = 0x0f8a7ea5;
const OP_DEPOSIT = 0x10000001;
const OP_REQUEST_TOKENS = 0x10000052;
const OP_ADVANCE = 0x10000004;

const DEPOSIT_VALUE = toNano('0.7'); // TON attached per deposit message
const FORWARD_TON = toNano('0.6'); // must fund the whole notify -> adapter -> router chain
const FAUCET_MIN_TON = toNano('0.5'); // 0.4 per claim (0.2 x 2 minters); top up below this

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

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const nowTs = () => Math.floor(Date.now() / 1000);

function unpackConfig(cell: Cell) {
  const s = cell.beginParse();
  return {
    epochLength: s.loadUint(32), depositCutoff: s.loadUint(32),
    commitWindow: s.loadUint(32), revealWindow: s.loadUint(32),
    minHoldEpochs: s.loadUint(16), prizeTiers: s.loadUint(8),
    skimBps: s.loadUint(16), drawBond: s.loadCoins(),
  };
}

const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

async function main() {
  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const me = w.address;

  const pool = Address.parseRaw(reg.poolCore);
  const minter = Address.parseRaw(reg.jettonMinter);
  const faucet = Address.parseRaw(reg.faucet);
  const walletCode = Cell.fromBoc(Buffer.from(JSON.parse(readFileSync(resolve('build/MockJettonWallet.compiled.json'), 'utf8')).hex, 'hex'))[0];
  const myJetton = contractAddress(0, { code: walletCode, data: walletData(0n, me, minter) });

  const players = derivePlayers(key.publicKey);

  const need = WEIGHTS.reduce((a, b) => a + b, 0n) * UNIT;
  console.log('operator', me.toString({ testOnly: true, bounceable: false }));
  console.log('players ', players.length, 'need', (need / UNIT).toString(), 'jUSDT');

  const confirm = async (prev: number, label: string) => {
    for (let i = 0; i < 40; i++) {
      await sleep(3);
      if (await rpc('seqno ' + label, () => w.getSeqno()) > prev) return;
    }
    throw new Error('seqno stuck at ' + label);
  };
  const sendMany = async (label: string, messages: any[]) => {
    const prev = await rpc('seqno', () => w.getSeqno());
    await w.sendTransfer({ seqno: prev, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY, messages });
    await confirm(prev, label);
  };
  const jbal = async (addr: Address) => {
    if ((await rpc('state', () => c.getContractState(addr))).state !== 'active') return 0n;
    return (await rpc('get_wallet_data', () => c.runMethod(addr, 'get_wallet_data'))).stack.readBigNumber();
  };

  // 1. the faucet mints from its own balance; drained, it fails at the mint hop and the
  // claim looks successful while no jettons arrive
  const fbal = await rpc('faucet balance', () => c.getBalance(faucet));
  console.log('faucet TON', (Number(fbal) / 1e9).toFixed(2));
  if (fbal < FAUCET_MIN_TON) {
    console.log('> top up faucet');
    await sendMany('faucet top-up', [internal({ to: faucet, value: toNano('1'), body: beginCell().endCell(), bounce: false })]);
  }

  // 2. claim once if short. Cooldown is per address and there is no admin bypass, so a
  // second claim inside the hour throws ERR_RATE_LIMITED (801).
  let held = await jbal(myJetton);
  if (held < need) {
    console.log('> claim from faucet, held', (held / UNIT).toString());
    await sendMany('claim', [internal({ to: faucet, value: toNano('0.3'), body: beginCell().storeUint(OP_REQUEST_TOKENS, 32).storeUint(0, 64).endCell(), bounce: false })]);
    for (let i = 0; i < 25 && (held = await jbal(myJetton)) < need; i++) await sleep(3);
  }
  console.log('jUSDT held', (held / UNIT).toString());
  if (held < need) {
    console.error(`not enough jUSDT: have ${held / UNIT}, need ${need / UNIT}. Faucet drips 1000 per hour per address.`);
    process.exit(1);
  }

  // 3. deposits are rejected past the deadline (ERR_DEPOSIT_CLOSED 410). Advancing recomputes
  // it to now + epochLength - depositCutoff and opens a fresh window.
  const readPool = async () => {
    const st = (await rpc('get_pool_data', () => c.runMethod(pool, 'get_pool_data'))).stack;
    return { epoch: Number(st.readBigNumber()), deadline: Number(st.readBigNumber()) };
  };
  const cfg = unpackConfig((await rpc('get_config', () => c.runMethod(pool, 'get_config'))).stack.readCell());
  let pd = await readPool();
  if (nowTs() >= pd.deadline) {
    // AdvanceEpoch throws ERR_BUSY while a draw is outstanding, and this send is NoBounce,
    // so it would fail silently and surface as "could not open a deposit window". Say what
    // is actually wrong instead. rawCycle settles a stale draw.
    if ((await rpc('get_draw_open', () => c.runMethod(pool, 'get_draw_open'))).stack.readBoolean()) {
      console.error('a draw is still open, so the epoch cannot advance and the window stays shut.');
      console.error('run scripts/rawCycle.ts to settle it, then re-run this.');
      process.exit(1);
    }
    console.log('> deposit window shut, advancing epoch');
    await sendMany('advance', [internal({ to: pool, value: toNano('1'), body: beginCell().storeUint(OP_ADVANCE, 32).storeUint(0, 64).endCell(), bounce: false })]);
    for (let i = 0; i < 25; i++) { await sleep(3); pd = await readPool(); if (nowTs() < pd.deadline) break; }
  }
  const windowLeft = pd.deadline - nowTs();
  console.log(`epoch ${pd.epoch}, window ${windowLeft}s (cutoff ${cfg.depositCutoff}, minHold ${cfg.minHoldEpochs})`);
  if (windowLeft <= 0) { console.error('could not open a deposit window'); process.exit(1); }

  // 4. skip anyone already holding weight so a re-run tops up the field instead of
  // double-depositing into it
  const todo: { to: Address; amount: bigint }[] = [];
  for (let i = 0; i < players.length; i++) {
    const st = (await rpc('get_balance_of', () => c.runMethod(pool, 'get_balance_of', [addrArg(players[i])]))).stack;
    const weight = st.readBigNumber();
    if (weight > 0n) { console.log(`  skip player ${i + 1}: weight ${weight / UNIT}`); continue; }
    todo.push({ to: players[i], amount: WEIGHTS[i] * UNIT });
  }
  if (!todo.length) { console.log('every player already seeded'); return; }

  // one wallet transaction carrying every deposit: v5r1 allows up to 255 out-actions, and
  // sequential sends would eat most of the window at ~5s per confirmation
  const messages = todo.map(({ to, amount }) => {
    const fwd = beginCell().storeUint(OP_DEPOSIT, 32).storeAddress(to).endCell();
    const body = beginCell()
      .storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
      .storeAddress(pool).storeAddress(me).storeMaybeRef(null)
      .storeCoins(FORWARD_TON).storeSlice(fwd.beginParse())
      .endCell();
    return internal({ to: myJetton, value: DEPOSIT_VALUE, body, bounce: true });
  });
  console.log(`> depositing for ${todo.length} players in one transaction`);
  await sendMany('deposits', messages);

  // 5. settle and report
  for (let i = 0; i < 20; i++) await sleep(3);
  let credited = 0n;
  for (let i = 0; i < players.length; i++) {
    const st = (await rpc('get_balance_of', () => c.runMethod(pool, 'get_balance_of', [addrArg(players[i])]))).stack;
    const weight = st.readBigNumber();
    const joinEpoch = st.readBigNumber();
    credited += weight;
    console.log(`  player ${String(i + 1).padStart(2)} ${players[i].toString({ testOnly: true })} weight ${String(weight / UNIT).padStart(4)} joinEpoch ${joinEpoch}`);
  }
  const st = (await rpc('get_pool_data', () => c.runMethod(pool, 'get_pool_data'))).stack;
  st.readBigNumber(); st.readBigNumber();
  console.log('totalPrincipal', (st.readBigNumber() / UNIT).toString(), 'credited', (credited / UNIT).toString());
  console.log(`\nplayers become draw-eligible after ${cfg.minHoldEpochs} epoch boundary; run rawAccrue then rawCycle`);
}

main().catch((e) => { console.error('seed failed:', explain(e)); process.exit(1); });