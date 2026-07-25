import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { walletData } from '../wrappers/mockStack';
import { harvestAmounts } from './demo';

// Injects yield into the mock venue and harvests it into the prize pot.
//
// Three hops, in this order, because the venue splits accounting from custody:
//   1. move underlying to the ROUTER, which is where provided liquidity physically sits
//   2. AccrueYield on the mock pool, which only bumps `reserve` - it never checks that
//      the jettons exist, so skipping (1) would inflate LP value against nothing and
//      strand every later withdrawal
//   3. HarvestStonfi on the adapter, which burns the yield-LP to the vault; the vault
//      then reports VaultCredit and pool-core credits prizePot
//
// Without this the adapter's LP value never exceeds principal, harvest yields nothing,
// and a draw selects winners then pays them zero.

const OP_TRANSFER = 0x0f8a7ea5;
const OP_ACCRUE = 0x7e571004;
const OP_HARVEST_STONFI = 0x10000035;

const UNIT = 10n ** 6n;
const DEFAULT_ACCRUE = 250n; // jUSDT; leaves headroom inside one 1000 faucet drip after seeding

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
const fmt = (v: bigint) => (v / UNIT).toString();

async function main() {
  const amount = (BigInt(process.argv[2] ?? DEFAULT_ACCRUE)) * UNIT;

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
  const adapter = Address.parseRaw(reg.adapter);
  const vault = Address.parseRaw(reg.vault);
  const router = Address.parseRaw(reg.router);
  const stonfiPool = Address.parseRaw(reg.stonfiPool);
  const minter = Address.parseRaw(reg.jettonMinter);
  const walletCode = Cell.fromBoc(Buffer.from(JSON.parse(readFileSync(resolve('build/MockJettonWallet.compiled.json'), 'utf8')).hex, 'hex'))[0];
  const myJetton = contractAddress(0, { code: walletCode, data: walletData(0n, me, minter) });

  const send = async (label: string, to: Address, value: bigint, body: Cell) => {
    console.log('>', label);
    const prev = await rpc('seqno', () => w.getSeqno());
    await w.sendTransfer({
      seqno: prev, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [internal({ to, value, body, bounce: false })],
    });
    for (let i = 0; i < 40; i++) {
      await sleep(3);
      if (await rpc('confirm ' + label, () => w.getSeqno()) > prev) return;
    }
    throw new Error('seqno stuck at ' + label);
  };

  const adapterState = async () => {
    const s = (await rpc('get_adapter_data', () => c.runMethod(adapter, 'get_adapter_data'))).stack;
    s.readAddress();
    return { principal: s.readBigNumber(), lpBalance: s.readBigNumber() };
  };
  const quote = async () => {
    const s = (await rpc('get_lp_quote', () => c.runMethod(stonfiPool, 'get_lp_quote'))).stack;
    return { reserve: s.readBigNumber(), lpSupply: s.readBigNumber() };
  };
  const potOf = async () => {
    const s = (await rpc('get_vault_data', () => c.runMethod(vault, 'get_vault_data'))).stack;
    s.readAddress(); s.readAddressOpt(); s.readAddressOpt();
    return s.readBigNumber();
  };
  const prizePot = async () => {
    const s = (await rpc('get_pool_data', () => c.runMethod(pool, 'get_pool_data'))).stack;
    s.readBigNumber(); s.readBigNumber(); s.readBigNumber();
    return s.readBigNumber();
  };
  const jbal = async (addr: Address) => {
    if ((await rpc('state', () => c.getContractState(addr))).state !== 'active') return 0n;
    return (await rpc('get_wallet_data', () => c.runMethod(addr, 'get_wallet_data'))).stack.readBigNumber();
  };

  const held = await jbal(myJetton);
  const before = { a: await adapterState(), q: await quote(), pot: await potOf(), prize: await prizePot() };
  console.log('accruing   ', fmt(amount), 'jUSDT (held', fmt(held) + ')');
  console.log('adapter    ', 'principal', fmt(before.a.principal), 'lp', fmt(before.a.lpBalance));
  console.log('venue      ', 'reserve', fmt(before.q.reserve), 'lpSupply', fmt(before.q.lpSupply));
  console.log('pot/prize  ', fmt(before.pot), '/', fmt(before.prize));

  if (before.a.principal === 0n) {
    console.error('adapter holds no principal - run scripts/rawSeedPlayers.ts first');
    process.exit(1);
  }
  if (held < amount) {
    console.error(`not enough jUSDT: have ${fmt(held)}, need ${fmt(amount)}`);
    process.exit(1);
  }

  // 1. custody: the underlying has to actually reach the router, or the reserve bump that
  // follows is backed by nothing. forwardTon 0 so no notification is raised on the router.
  const transferBody = beginCell()
    .storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(router).storeAddress(me).storeMaybeRef(null)
    .storeCoins(0).storeUint(0, 1)
    .endCell();
  await send('transfer underlying to router', myJetton, toNano('0.2'), transferBody);

  // 2. accounting: admin-gated on the mock pool, bumps reserve without touching lpSupply,
  // so every existing LP is now worth proportionally more
  await send('accrue reserve', stonfiPool, toNano('0.1'),
    beginCell().storeUint(OP_ACCRUE, 32).storeUint(0, 64).storeCoins(amount).endCell());

  const q = await quote();
  const a = await adapterState();
  const plan = harvestAmounts({ principal: a.principal, lpBalance: a.lpBalance }, q);
  console.log('venue now  ', 'reserve', fmt(q.reserve), 'lpSupply', fmt(q.lpSupply));
  console.log('harvest    ', 'lpToBurn', fmt(plan.lpToBurn), 'gross', fmt(plan.gross));
  if (plan.gross === 0n) {
    console.error('nothing harvestable - reserve did not move, check the accrue succeeded');
    process.exit(1);
  }

  // 3. burn the yield-LP to the vault. 2 TON funds the multi-hop burn chain (BURN_VALUE is
  // 1 TON inside the adapter and every hop carries the remainder).
  await send('harvest into vault', adapter, toNano('2'),
    beginCell().storeUint(OP_HARVEST_STONFI, 32).storeUint(0, 64)
      .storeCoins(plan.lpToBurn).storeCoins(plan.gross).storeAddress(vault).endCell());

  // the vault reports what actually landed and pool-core credits prizePot from that report,
  // so both must move or the two ledgers have diverged
  let pot = 0n, prize = 0n;
  for (let i = 0; i < 25; i++) {
    await sleep(3);
    pot = await potOf();
    prize = await prizePot();
    if (pot > before.pot && prize > before.prize) break;
  }

  const after = await adapterState();
  console.log('\nadapter    ', 'principal', fmt(after.principal), 'lp', fmt(after.lpBalance));
  console.log('vault pot  ', fmt(before.pot), '->', fmt(pot));
  console.log('prizePot   ', fmt(before.prize), '->', fmt(prize));

  if (after.principal !== before.a.principal) {
    console.error('principal moved during a harvest - it must not; only yield-LP is burned');
    process.exit(1);
  }
  if (pot <= before.pot || prize <= before.prize) {
    console.error('\nharvest did not reach the pot.');
    console.error('if vault pot moved but prizePot did not, the vault is not wired to pool-core');
    process.exit(1);
  }
  console.log('\nyield is in the pot; run scripts/rawCycle.ts to draw for it');
}

main().catch((e) => { console.error('accrue failed:', explain(e)); process.exit(1); });