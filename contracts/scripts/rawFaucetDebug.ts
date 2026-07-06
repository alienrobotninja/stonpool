import { readFileSync } from 'fs';
import { TonClient } from '@ton/ton';
import { Address } from '@ton/core';

const FAUCET = Address.parse('0:fd9304b1b6a48095946e03f453adab8ff200a0ca68dbf2370ec7f6ff1001fe9b');
const apiKey = readFileSync('.env', 'utf8').match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const r = await c.runMethod(FAUCET, 'get_faucet_data');
  r.stack.readAddress();            // admin
  console.log('usdt', r.stack.readAddressOpt()?.toString({ testOnly: true }) ?? 'NULL');
  console.log('usdc', r.stack.readAddressOpt()?.toString({ testOnly: true }) ?? 'NULL');
}
main();