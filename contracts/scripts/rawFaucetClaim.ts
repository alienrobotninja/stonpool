import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { walletData } from '../wrappers/mockStack';

const OP_REQUEST = 0x10000052;
const FAUCET = Address.parse('0:fd9304b1b6a48095946e03f453adab8ff200a0ca68dbf2370ec7f6ff1001fe9b');
const JUSDT = Address.parse('0:35641705ecea9f16147e51e462ccd4a3c44f32bd4cb98e1d11bc3edf4fd10898');

const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)![1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
const walletCode = Cell.fromBoc(Buffer.from(JSON.parse(readFileSync('build/MockJettonWallet.compiled.json', 'utf8')).hex, 'hex'))[0];

async function main() {
  const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const wallet = client.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const me = wallet.address;

  const myJusdt = contractAddress(0, { code: walletCode, data: walletData(0n, me, JUSDT) });
  const before = await bal(client, myJusdt);

  const seqno = await wallet.getSeqno();
  await wallet.sendTransfer({
    seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: FAUCET, value: toNano('0.3'), body: beginCell().storeUint(OP_REQUEST, 32).storeUint(0, 64).endCell(), bounce: false })],
  });
  console.log('claim sent, waiting...');
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 3000)); if (await wallet.getSeqno() > seqno) break; }

  await new Promise(r => setTimeout(r, 5000));
  const after = await bal(client, myJusdt);
  console.log('jUSDT wallet', myJusdt.toString({ testOnly: true }));
  console.log('before', before, 'after', after, after > before ? 'DRIP OK' : 'NO DRIP');
}

async function bal(client: TonClient, w: Address): Promise<bigint> {
  if ((await client.getContractState(w)).state !== 'active') return 0n;
  const r = await client.runMethod(w, 'get_wallet_data');
  return r.stack.readBigNumber();
}

main();