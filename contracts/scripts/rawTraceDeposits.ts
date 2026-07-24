import { readFileSync } from 'fs';
import { resolve } from 'path';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, contractAddress } from '@ton/core';
import { walletData } from '../wrappers/mockStack';
import { UNIT } from './demoPlayers';

// Localizes principal that pool-core has booked but the adapter never received. Every
// deposit walks operator wallet -> pool wallet -> pool-core (credit) -> adapter wallet ->
// adapter (book) -> router (provide). A break anywhere after the credit leaves pool-core
// claiming principal the adapter cannot cover, which surfaces later as failed or
// haircut withdrawals. The jettons do not vanish, so whichever wallet is holding them
// names the hop that failed.

function envVar(env: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`);
  const hits = env.split(/\r?\n/).map((l) => l.match(re)?.[1]).filter((v): v is string => !!v);
  return hits[hits.length - 1]?.replace(/^["']|["']$/g, '');
}

const explain = (e: any): string => {
  const d = e?.response?.data;
  return d?.error ? `${e.response.status} ${d.error}` : (e?.message ?? String(e));
};

const fmt = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const ton = (v: bigint) => (Number(v) / 1e9).toFixed(3);

async function main() {
  const env = readFileSync(resolve('.env'), 'utf8');
  const mnemonic = envVar(env, 'WALLET_MNEMONIC')!.split(/\s+/);
  const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
  const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
  const reg = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));

  const c = new TonClient({ endpoint, apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const me = WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }).address;

  const minter = Address.parseRaw(reg.jettonMinter);
  const walletCode = Cell.fromBoc(Buffer.from(JSON.parse(readFileSync(resolve('build/MockJettonWallet.compiled.json'), 'utf8')).hex, 'hex'))[0];
  const jw = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });

  const owners: [string, Address][] = [
    ['operator', me],
    ['poolCore', Address.parseRaw(reg.poolCore)],
    ['adapter', Address.parseRaw(reg.adapter)],
    ['router', Address.parseRaw(reg.router)],
    ['vault', Address.parseRaw(reg.vault)],
    ['stonfiPool', Address.parseRaw(reg.stonfiPool)],
  ];

  console.log('owner        TON      jUSDT held   jetton wallet state');
  let total = 0n;
  for (const [name, owner] of owners) {
    const tonBal = await c.getBalance(owner);
    const w = jw(owner);
    const st = await c.getContractState(w);
    let held = 0n;
    if (st.state === 'active') {
      try { held = (await c.runMethod(w, 'get_wallet_data')).stack.readBigNumber(); } catch { held = -1n; }
    }
    total += held > 0n ? held : 0n;
    console.log(`${name.padEnd(11)} ${ton(tonBal).padStart(8)} ${fmt(held).padStart(13)}   ${st.state}`);
  }
  console.log(`${''.padEnd(11)} ${''.padStart(8)} ${fmt(total).padStart(13)}   total in the stack`);

  const pd = (await c.runMethod(Address.parseRaw(reg.poolCore), 'get_pool_data')).stack;
  pd.readBigNumber(); pd.readBigNumber();
  const booked = pd.readBigNumber();
  const ad = (await c.runMethod(Address.parseRaw(reg.adapter), 'get_adapter_data')).stack;
  ad.readAddress();
  const deployed = ad.readBigNumber();
  const lp = ad.readBigNumber();

  console.log(`\npool-core booked principal : ${fmt(booked)}`);
  console.log(`adapter deployed principal: ${fmt(deployed)}  lp ${fmt(lp)}`);
  const gap = booked - deployed;
  if (gap > 0n) {
    console.log(`\nGAP ${fmt(gap)} booked but never reached the adapter.`);
    console.log('whichever wallet above holds it names the hop that failed:');
    console.log('  poolCore wallet  -> pool-core credited, then its onward transfer failed');
    console.log('  adapter wallet   -> jettons arrived but the adapter never booked them');
    console.log('  operator wallet  -> the deposit never left, so pool-core should not have credited');
  } else {
    console.log('\nno gap: every booked unit is deployed');
  }
}

main().catch((e) => { console.error('trace failed:', explain(e)); process.exit(1); });