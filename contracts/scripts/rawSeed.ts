import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { walletData } from '../wrappers/mockStack';

const OP_TRANSFER = 0x0f8a7ea5, OP_DEPOSIT = 0x10000001, OP_REQUEST = 0x10000052;
const DEPOSIT = 500n * 10n ** 6n;

const reg = JSON.parse(readFileSync('addresses/testnet.json', 'utf8'));
const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)[1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();
const walletCode = Cell.fromBoc(Buffer.from(JSON.parse(readFileSync('build/MockJettonWallet.compiled.json', 'utf8')).hex, 'hex'))[0];

async function jbal(c, w) {
  if ((await c.getContractState(w)).state !== 'active') return 0n;
  return (await c.runMethod(w, 'get_wallet_data')).stack.readBigNumber();
}

async function main() {
  const c = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const w = c.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const me = w.address;
  const pool = Address.parse(reg.poolCore);
  const minter = Address.parse(reg.jettonMinter);
  const faucet = Address.parse(reg.faucet);
  const myJetton = contractAddress(0, { code: walletCode, data: walletData(0n, me, minter) });

  const wait = async (prev) => { for (let i = 0; i < 40; i++) { await new Promise(r => setTimeout(r, 3000)); if (await w.getSeqno() > prev) return; } throw new Error('seqno stuck'); };

  if (await jbal(c, myJetton) < DEPOSIT) {
    let s = await w.getSeqno();
    await w.sendTransfer({ seqno: s, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
      messages: [internal({ to: faucet, value: toNano('0.3'), body: beginCell().storeUint(OP_REQUEST, 32).storeUint(0, 64).endCell(), bounce: false })] });
    console.log('claim sent');
    await wait(s);
    for (let i = 0; i < 20 && await jbal(c, myJetton) < DEPOSIT; i++) await new Promise(r => setTimeout(r, 3000));
  }
  console.log('jUSDT balance', (await jbal(c, myJetton)).toString());

  const fwd = beginCell().storeUint(OP_DEPOSIT, 32).storeAddress(me).endCell();
  const body = beginCell()
    .storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(DEPOSIT)
    .storeAddress(pool).storeAddress(me).storeMaybeRef(null)
    .storeCoins(toNano('0.6')).storeSlice(fwd.beginParse())
    .endCell();

  let s = await w.getSeqno();
  await w.sendTransfer({ seqno: s, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [internal({ to: myJetton, value: toNano('0.7'), body, bounce: true })] });
  console.log('deposit sent, waiting...');
  await wait(s);
  await new Promise(r => setTimeout(r, 5000));

  const pd = await c.runMethod(pool, 'get_pool_data');
  pd.stack.readBigNumber(); pd.stack.readBigNumber(); pd.stack.readBigNumber();
  console.log('totalPrincipal', pd.stack.readBigNumber().toString());
}
main();
