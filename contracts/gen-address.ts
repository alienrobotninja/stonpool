// gen-address.ts, run from contracts/
import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';

const env = readFileSync('.env', 'utf8');
const words = env.match(/WALLET_MNEMONIC=(.+)/)?.[1]?.trim().split(' ');
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
if (!words || words.length !== 24) throw new Error('WALLET_MNEMONIC missing or not 24 words in .env');

async function main() {
  const { publicKey } = await mnemonicToPrivateKey(words);
  const wallet = WalletContractV5R1.create({ workchain: 0, publicKey }); // no walletId - matches how this wallet was actually made
  console.log('address:', wallet.address.toString({ testOnly: true, bounceable: false }));

  const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const balance = await client.open(wallet).getBalance();
  console.log('balance:', Number(balance) / 1e9, 'TON');
}
main();