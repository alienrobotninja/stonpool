import { compile, NetworkProvider } from '@ton/blueprint';
import { Address, contractAddress } from '@ton/core';
import { faucetData, minterData, offchainContent } from '../wrappers/mockStack';

export async function run(provider: NetworkProvider) {
  const admin = provider.sender().address!;
  const walletCode = await compile('MockJettonWallet');
  const minterCode = await compile('MockJettonMinter');
  const faucetCode = await compile('Faucet');

  // minters are admined by the faucet, not the deployer (faucet mints on claim)
  const faucet = contractAddress(0, { code: faucetCode, data: faucetData(admin) });
  const minter = (uri: string) =>
    contractAddress(0, {
      code: minterCode,
      data: minterData(faucet, offchainContent(`https://stonpool.test/${uri}`), walletCode),
    });

  const rows: [string, Address][] = [
    ['faucet', faucet],
    ['jUSDT', minter('usdt.json')],
    ['jUSDC', minter('usdc.json')],
  ];

  const ui = provider.ui();
  for (const [name, a] of rows) {
    const live = await provider.isContractDeployed(a);
    const bal = live ? Number((await provider.provider(a).getState()).balance) / 1e9 : 0;
    ui.write(`${name}\t${a.toString({ testOnly: true })}\tdeployed=${live}\tbal=${bal.toFixed(3)}`);
    ui.write(`  raw\t${a.toRawString()}`);
  }
}