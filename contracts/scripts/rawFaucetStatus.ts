import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, beginCell } from '@ton/core';

// Reads the faucet's per-address cooldown against the operator wallet and reports whether a
// claim would land now. The contract has no admin bypass, so a claim inside the window throws
// ERR_RATE_LIMITED and the seeder aborts after having already spent gas.

const UNIT = 10n ** 6n;
const NEED = 960n * UNIT; // 710 to seed twelve players, 250 for the yield injection

function envVar(env: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`);
  const hits = env.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter((v): v is string => !!v);
  return hits[hits.length - 1]?.replace(/^["']|["']$/g, '');
}

const isTransient = (e: any) =>
  e?.code === 'ECONNABORTED' || e?.code === 'ETIMEDOUT' || e?.code === 'ECONNRESET' ||
  /timeout|socket hang up|network|EAI_AGAIN/i.test(e?.message ?? '') ||
  e?.response?.status === 429 || e?.response?.status >= 500;

async function rpc<T>(label: string, fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (!isTransient(e) || i >= tries) throw e;
      console.log(`  retry ${i}/${tries - 1} ${label}`);
      await new Promise((r) => setTimeout(r, 2500 * i));
    }
  }
}

const hms = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m ${s % 60}s`;
};

async function main() {
  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const me = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey })).address;
  const faucet = Address.parseRaw(reg.faucet);
  const minter = Address.parseRaw(reg.jettonMinter);
  const arg = { type: 'slice' as const, cell: beginCell().storeAddress(me).endCell() };

  const fd = (await rpc('get_faucet_data', () => c.runMethod(faucet, 'get_faucet_data'))).stack;
  fd.readAddress(); fd.readAddressOpt(); fd.readAddressOpt();
  const drip = fd.readBigNumber();
  fd.readBigNumber();
  const cooldown = fd.readNumber();

  const last = (await rpc('get_last_claim', () => c.runMethod(faucet, 'get_last_claim', [arg]))).stack.readNumber();
  const ton = Number(await rpc('faucet balance', () => c.getBalance(faucet))) / 1e9;

  let held = 0n;
  const wa = (await rpc('get_wallet_address', () => c.runMethod(minter, 'get_wallet_address', [arg]))).stack.readAddress();
  if ((await rpc('state', () => c.getContractState(wa))).state === 'active') {
    held = (await rpc('get_wallet_data', () => c.runMethod(wa, 'get_wallet_data'))).stack.readBigNumber();
  }

  const now = Math.floor(Date.now() / 1000);
  const elapsed = last === 0 ? Infinity : now - last;
  const left = Math.max(cooldown - elapsed, 0);

  console.log('operator  ', me.toString({ testOnly: true, bounceable: false }));
  console.log('faucet    ', reg.faucet, `${ton.toFixed(2)} TON`);
  console.log('drip      ', (drip / UNIT).toString(), 'jUSDT per claim, cooldown', hms(cooldown));
  console.log('last claim', last === 0 ? 'never' : `${new Date(last * 1000).toISOString()} (${hms(elapsed)} ago)`);
  console.log('held      ', (held / UNIT).toString(), 'jUSDT, need', (NEED / UNIT).toString());

  if (ton < 0.5) console.log('\nWARN faucet is low on TON; it pays the mint gas and will fail silently when drained');
  if (held >= NEED) {
    console.log('\nREADY no claim needed, the operator already holds enough');
    return;
  }
  if (left > 0) {
    console.log(`\nWAIT ${hms(left)} before a claim will land. Claiming now throws ERR_RATE_LIMITED (801)`);
    process.exit(1);
  }
  console.log('\nREADY a claim will land now');
}

main().catch((e) => { console.error('faucet status failed:', e?.message ?? e); process.exit(1); });