import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, beginCell, internal, toNano, SendMode } from '@ton/core';

const OP_ADVANCE = 0x10000004;
const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)[1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const pool = Address.parse(reg.poolCore);
  const seqno = await w.getSeqno();
  await w.sendTransfer({ seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: pool, value: toNano('1'), body: beginCell().storeUint(OP_ADVANCE, 32).storeUint(0, 64).endCell(), bounce: false })] });
  console.log('advance sent, waiting...');
  for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 3000)); if (await w.getSeqno() > seqno) break; }
  const pd = await c.runMethod(pool, 'get_pool_data');
  const epoch = pd.stack.readBigNumber();
  const deadline = pd.stack.readBigNumber();
  console.log('epoch', epoch.toString(), '| deposit_deadline', deadline.toString(), '| now', Math.floor(Date.now() / 1000), '| open', Number(deadline) > Math.floor(Date.now() / 1000));
}
main();
