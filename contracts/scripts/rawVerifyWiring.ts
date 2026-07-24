import { readFileSync } from 'fs';
import { resolve } from 'path';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';
import { AddressRegistry } from './addresses';

// Proves the redeploy wired correctly and started clean, on-chain. Load-bearing checks: the vault's poolCore link (or VaultCredit never fires
// and prizePot stays 0 forever) and the REUSED adapter/router state (the deploy skipped them
// as already-active, so they must be verified zero or accounting is off from block zero).

function envVar(env: string, name: string): string | undefined {
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.+?)\\s*$`);
  const hits = env.split(/\r?\n/).map(l => l.match(re)?.[1]).filter((v): v is string => !!v);
  return hits[hits.length - 1]?.replace(/^["']|["']$/g, '');
}

const env = readFileSync(resolve('.env'), 'utf8');
const apiKey = envVar(env, 'TONCENTER_TESTNET_KEY');
const endpoint = envVar(env, 'TONCENTER_TESTNET_ENDPOINT') ?? 'https://testnet.toncenter.com/api/v2/jsonRPC';
const reg: AddressRegistry = JSON.parse(readFileSync(resolve('addresses/testnet.json'), 'utf8'));

const c = new TonClient({ endpoint, apiKey });
const addr = (s: string) => Address.parseRaw(s);
const poolCore = addr(reg.poolCore);

let fails = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) fails++;
};
const eqAddr = (a: Address | null, b: Address) => !!a && a.equals(b);
const short = (a: Address | null) => a ? a.toString({ testOnly: true }).slice(0, 10) : 'null';

async function main() {
  console.log('poolCore', reg.poolCore, '\n');

  // pool-core: fresh ledger
  {
    const s = (await c.runMethod(poolCore, 'get_pool_data')).stack;
    s.readBigNumber(); s.readBigNumber();
    const totalPrincipal = s.readBigNumber(); const prizePot = s.readBigNumber();
    check('pool-core totalPrincipal == 0', totalPrincipal === 0n, `got ${totalPrincipal}`);
    check('pool-core prizePot == 0', prizePot === 0n, `got ${prizePot}`);
  }

  // vault: poolCore wired (critical) + clean pot
  {
    const s = (await c.runMethod(addr(reg.vault), 'get_vault_data')).stack;
    s.readAddress(); const vPoolCore = s.readAddressOpt(); s.readAddressOpt();
    const pot = s.readBigNumber();
    check('vault.poolCore == poolCore', eqAddr(vPoolCore, poolCore), `got ${short(vPoolCore)}`);
    check('vault.potBalance == 0', pot === 0n, `got ${pot}`);
  }

  // adapter (REUSED): poolCore wired + zero principal/lp
  {
    const s = (await c.runMethod(addr(reg.adapter), 'get_adapter_data')).stack;
    s.readAddress(); const principal = s.readBigNumber(); const lp = s.readBigNumber();
    const aPoolCore = s.readAddressOpt();
    check('adapter.poolCore == poolCore', eqAddr(aPoolCore, poolCore), `got ${short(aPoolCore)}`);
    check('adapter.principal == 0 (reused-state)', principal === 0n, `got ${principal}`);
    check('adapter.lpBalance == 0 (reused-state)', lp === 0n, `got ${lp}`);
  }

  // governor: poolCore link
  {
    const s = (await c.runMethod(addr(reg.governor), 'get_governor_data')).stack;
    s.readAddress(); const gPoolCore = s.readAddress();
    check('governor.poolCore == poolCore', gPoolCore.equals(poolCore), `got ${short(gPoolCore)}`);
  }

  // router (REUSED): re-wired to the fresh stonfi pool
  {
    const s = (await c.runMethod(addr(reg.router), 'get_router_data')).stack;
    s.readAddress(); s.readAddressOpt(); const rPool = s.readAddressOpt();
    check('router.stonfiPool == stonfiPool', eqAddr(rPool, addr(reg.stonfiPool)), `got ${short(rPool)}`);
  }

  // stonfi pool (fresh): empty reserves
  {
    const s = (await c.runMethod(addr(reg.stonfiPool), 'get_pool_data')).stack;
    s.readAddress(); s.readAddressOpt();
    const reserve = s.readBigNumber(); const lpSupply = s.readBigNumber();
    check('stonfiPool.reserve == 0', reserve === 0n, `got ${reserve}`);
    check('stonfiPool.lpSupply == 0', lpSupply === 0n, `got ${lpSupply}`);
  }

  console.log(fails === 0 ? '\nall wiring + clean-state checks passed' : `\n${fails} check(s) FAILED — fix before step 4`);
  process.exit(fails ? 1 : 0);
}

main().catch(e => { console.error('verify failed:', e?.response?.data?.error ?? e?.message ?? e); process.exit(1); });