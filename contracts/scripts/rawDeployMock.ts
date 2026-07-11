import { readFileSync } from 'fs';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { TonClient, WalletContractV5R1 } from '@ton/ton';
import { Address, Cell, beginCell, contractAddress, internal, toNano, SendMode } from '@ton/core';
import { faucetData, minterData, offchainContent, FAUCET_FUNDING } from '../wrappers/mockStack';

const OP_CONFIGURE = 0x10000053;
const env = readFileSync('.env', 'utf8');
const mnemonic = env.match(/WALLET_MNEMONIC=(.+)/)![1].trim().split(/\s+/);
const apiKey = env.match(/TONCENTER_TESTNET_KEY=(.+)/)?.[1]?.trim();

const loadCode = (name: string): Cell =>
  Cell.fromBoc(Buffer.from(JSON.parse(readFileSync(`build/${name}.compiled.json`, 'utf8')).hex, 'hex'))[0];

async function main() {
  const client = new TonClient({ endpoint: 'https://testnet.toncenter.com/api/v2/jsonRPC', apiKey });
  const key = await mnemonicToPrivateKey(mnemonic);
  const wallet = client.open(WalletContractV5R1.create({ workchain: 0, publicKey: key.publicKey }));
  const admin = wallet.address;
  console.log('deployer', admin.toString({ testOnly: true, bounceable: false }), Number(await client.getBalance(admin)) / 1e9, 'TON');

  const faucetInit = { code: loadCode('Faucet'), data: faucetData(admin) };
  const faucet = contractAddress(0, faucetInit);
  const minterCode = loadCode('MockJettonMinter');
  const walletCode = loadCode('MockJettonWallet');
  const usdtInit = { code: minterCode, data: minterData(faucet, offchainContent('https://stonpool.test/usdt.json'), walletCode) };
  const usdcInit = { code: minterCode, data: minterData(faucet, offchainContent('https://stonpool.test/usdc.json'), walletCode) };
  const usdt = contractAddress(0, usdtInit);
  const usdc = contractAddress(0, usdcInit);

  const configureBody = beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeAddress(usdt).storeAddress(usdc).endCell();

  const seqno = await wallet.getSeqno();
  await wallet.sendTransfer({
    seqno, secretKey: key.secretKey, sendMode: SendMode.PAY_GAS_SEPARATELY,
    messages: [
      internal({ to: faucet, value: FAUCET_FUNDING, init: faucetInit, body: beginCell().endCell(), bounce: false }),
      internal({ to: usdt, value: toNano('0.1'), init: usdtInit, body: beginCell().endCell(), bounce: false }),
      internal({ to: usdc, value: toNano('0.1'), init: usdcInit, body: beginCell().endCell(), bounce: false }),
      internal({ to: faucet, value: toNano('0.1'), body: configureBody, bounce: false }),
    ],
  });
  console.log('sent seqno', seqno, 'waiting...');

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 3000));
    if (await wallet.getSeqno() > seqno) break;
  }

  for (const [n, a] of [['faucet', faucet], ['jUSDT', usdt], ['jUSDC', usdc]] as [string, Address][]) {
    console.log(n, a.toString({ testOnly: true }), (await client.getContractState(a)).state, Number(await client.getBalance(a)) / 1e9);
    console.log('  raw', a.toRawString());
  }
}

main();