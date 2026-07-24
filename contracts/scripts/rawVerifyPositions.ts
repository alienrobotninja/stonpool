import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient } from '@ton/ton';
import { Address, beginCell, Cell } from '@ton/core';
import { derivePlayers, operatorAddress, UNIT } from './demoPlayers';

// Cross-checks what the API serves against what the chain holds. The indexer builds
// positions from transaction history, so it can drift from the ledger without anything
// erroring - the API would just quietly serve stale or missing rows. Comparing both sides
// per player is the only way to catch that.
//
// Odds are on different scales by design: pool-core's get_odds returns basis points
// (oddsBps), the API returns a share in [0,1]. Both gate on the same eligibility rule
// (currentEpoch - joinEpoch >= minHoldEpochs), so freshly seeded players read 0 on BOTH
// sides until an epoch boundary passes. That is correct, not a failure.

const API_DEFAULT = 'https://stonpool-api.fly.dev';
const BPS = 10000;
const TOL = 0.0002; // one basis point of integer rounding, plus float slack

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
const fmt = (v: bigint) => (v / UNIT).toString();

type ApiPosition = { address: string; principal: number; join_epoch: number; eligible: boolean; odds: number };

async function main() {
  const apiBase = process.argv[2] ?? process.env.STONPOOL_API ?? API_DEFAULT;

  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const pool = Address.parseRaw(reg.poolCore);
  const players = derivePlayers(key.publicKey);

  console.log('poolCore', pool.toString({ testOnly: true }));
  console.log('api     ', apiBase);
  console.log('operator', operatorAddress(key.publicKey).toString({ testOnly: true, bounceable: false }));

  const cfg = unpackConfig((await rpc('get_config', () => c.runMethod(pool, 'get_config'))).stack.readCell());
  const pdStack = (await rpc('get_pool_data', () => c.runMethod(pool, 'get_pool_data'))).stack;
  const epoch = Number(pdStack.readBigNumber());
  pdStack.readBigNumber();
  const totalPrincipal = pdStack.readBigNumber();
  const prizePot = pdStack.readBigNumber();
  const totalWeight = (await rpc('get_total_weight', () => c.runMethod(pool, 'get_total_weight'))).stack.readBigNumber();
  const participants = Number((await rpc('get_participant_count', () => c.runMethod(pool, 'get_participant_count'))).stack.readBigNumber());

  console.log(`\nepoch ${epoch}  participants ${participants}  totalPrincipal ${fmt(totalPrincipal)}  eligibleWeight ${fmt(totalWeight)}  prizePot ${fmt(prizePot)}`);

  // read the chain side first; the API is compared against it, never the other way round
  const onchain = [];
  for (const p of players) {
    const s = (await rpc('get_balance_of', () => c.runMethod(pool, 'get_balance_of', [addrArg(p)]))).stack;
    const weight = s.readBigNumber();
    const joinEpoch = Number(s.readBigNumber());
    const oddsBps = Number((await rpc('get_odds', () => c.runMethod(pool, 'get_odds', [addrArg(p)]))).stack.readBigNumber());
    onchain.push({ addr: p, weight, joinEpoch, oddsBps });
  }

  const seeded = onchain.filter((o) => o.weight > 0n);
  if (!seeded.length) {
    console.error('\nno player carries weight on-chain - run scripts/rawSeedPlayers.ts first');
    process.exit(1);
  }

  let api: ApiPosition[];
  try {
    const res = await fetch(`${apiBase}/positions?limit=1000`);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    api = (await res.json()) as ApiPosition[];
  } catch (e) {
    console.error('\ncould not read the API:', (e as any)?.message ?? e);
    process.exit(1);
  }
  const byAddr = new Map(api.map((p) => [Address.parse(p.address).toRawString(), p]));

  let fails = 0;
  const bad = (msg: string) => { console.log('  FAIL ' + msg); fails++; };

  console.log('\n  #   weight  joinEp  onchain_bps   api_odds  eligible');
  for (let i = 0; i < onchain.length; i++) {
    const o = onchain[i];
    if (o.weight === 0n) continue;
    const row = byAddr.get(o.addr.toRawString());
    const eligible = epoch - o.joinEpoch >= cfg.minHoldEpochs;
    const apiOdds = row ? row.odds : NaN;
    console.log(
      `  ${String(i + 1).padStart(2)}  ${fmt(o.weight).padStart(6)}  ${String(o.joinEpoch).padStart(6)}  ` +
      `${String(o.oddsBps).padStart(11)}  ${(row ? apiOdds.toFixed(6) : 'absent').padStart(9)}  ${eligible}`);

    if (!row) { bad(`player ${i + 1} missing from /positions`); continue; }
    if (BigInt(row.principal) !== o.weight) bad(`player ${i + 1} principal ${row.principal} != on-chain ${o.weight}`);
    if (row.join_epoch !== o.joinEpoch) bad(`player ${i + 1} join_epoch ${row.join_epoch} != on-chain ${o.joinEpoch}`);
    if (row.eligible !== eligible) bad(`player ${i + 1} eligible ${row.eligible} != derived ${eligible}`);
    if (Math.abs(apiOdds - o.oddsBps / BPS) > TOL) {
      bad(`player ${i + 1} odds ${apiOdds.toFixed(6)} != on-chain ${(o.oddsBps / BPS).toFixed(6)}`);
    }
  }

  const anyEligible = seeded.some((o) => epoch - o.joinEpoch >= cfg.minHoldEpochs);
  const bpsSum = seeded.reduce((a, o) => a + o.oddsBps, 0);
  if (anyEligible) {
    // integer bps per player, so the sum lands just under 10000; a large shortfall means
    // eligibility is being computed differently than the ledger implies
    if (bpsSum > BPS || bpsSum < BPS - seeded.length) bad(`odds sum ${bpsSum} bps is not ~${BPS}`);
    else console.log(`\nodds sum ${bpsSum} bps (rounding loses <=1 bps per player)`);
  } else {
    console.log(`\nno player is eligible yet: minHoldEpochs ${cfg.minHoldEpochs}, all joined at epoch ${seeded[0].joinEpoch},`);
    console.log('so odds are 0 on both sides by design. Re-run after the next AdvanceEpoch.');
  }

  console.log(fails === 0 ? '\napi and chain agree' : `\n${fails} mismatch(es)`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => { console.error('verify failed:', explain(e)); process.exit(1); });