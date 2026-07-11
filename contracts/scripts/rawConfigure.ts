import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, beginCell, internal, toNano, SendMode } from '@ton/core';

const OP_CONFIGURE = 0x10000053;
const FAUCET = Address.parse('0:fd9304b1b6a48095946e03f453adab8ff200a0ca68dbf2370ec7f6ff1001fe9b');
const USDT = Address.parse('0:35641705ecea9f16147e51e462ccd4a3c44f32bd4cb98e1d11bc3edf4fd10898');
const USDC = Address.parse('0:9d15236fdb85306225703f226da634af6e036f52dd15255de815cfeac0dad529');

const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)![1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const seqno = await w.getSeqno();
  await w.sendTransfer({
    seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({
      to: FAUCET, value: toNano('0.1'), bounce: true,
      body: beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeAddress(USDT).storeAddress(USDC).endCell(),
    })],
  });
  console.log('configure sent, waiting...');
  for (let i = 0; i < 30; i++) { await new Promise(r => setTimeout(r, 3000)); if (await w.getSeqno() > seqno) break; }
  const r = await c.runMethod(FAUCET, 'get_faucet_data');
  r.stack.readAddress();
  console.log('usdt', r.stack.readAddressOpt()?.toString({ testOnly: true }) ?? 'NULL');
  console.log('usdc', r.stack.readAddressOpt()?.toString({ testOnly: true }) ?? 'NULL');
}
main();