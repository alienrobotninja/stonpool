import { readFileSync } from 'fs';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const apiKey = readFileSync('.env', 'utf8').match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function jbal(c, w) {
  if ((await c.getContractState(w)).state !== 'active') return 'inactive';
  return (await c.runMethod(w, 'get_wallet_data')).stack.readBigNumber().toString();
}
async function txs(c, a, n) {
  const t = await c.getTransactions(Address.parse(a), { limit: n });
  for (const x of t) { const d = x.description; console.log('  exit', d.computePhase?.exitCode, 'aborted', d.aborted, 'out', d.actionPhase?.totalActions); }
}

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  console.log('pool jetton-wallet bal', await jbal(c, reg.wallets.pool));
  console.log('pool-core txs:'); await txs(c, reg.poolCore, 3);
  console.log('pool jetton-wallet txs:'); await txs(c, reg.wallets.pool, 3);
}
main();
