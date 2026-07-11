import { readFileSync } from 'fs';
import { TonClient } from '@ton/ton';
import { Address, beginCell } from '@ton/core';

const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const apiKey = readFileSync('.env', 'utf8').match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const minter = Address.parse(reg.jettonMinter);
  const pool = Address.parse(reg.poolCore);
  const r = await c.runMethod(minter, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(pool).endCell() }]);
  const real = r.stack.readAddress();
  console.log('minter says pool wallet =', real.toString());
  console.log('registry pool wallet    =', Address.parse(reg.wallets.pool).toString());
  console.log('match', real.equals(Address.parse(reg.wallets.pool)));
}
main();
