import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, beginCell, internal, toNano, SendMode } from '@ton/core';

const OP_CONFIGURE_CORE = 0x10000073, ROLE_JETTON_WALLET = 0;
const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)[1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const pool = Address.parse(reg.poolCore);
  const minter = Address.parse(reg.jettonMinter);
  const r = await c.runMethod(minter, 'get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(pool).endCell() }]);
  const realWallet = r.stack.readAddress();

  const seqno = await w.getSeqno();
  await w.sendTransfer({ seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: pool, value: toNano('0.1'),
      body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(ROLE_JETTON_WALLET, 8).storeAddress(realWallet).endCell(), bounce: false })] });
  console.log('rewire sent to', realWallet.toString(), 'waiting...');
  for (let i = 0; i < 40; i++) { await new Promise(rs => setTimeout(rs, 3000)); if (await w.getSeqno() > seqno) break; }
  console.log('done');
}
main();
