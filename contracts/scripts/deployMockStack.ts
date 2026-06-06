import { contractAddress, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import {
  MockStackContract, faucetData, minterData, offchainContent, FAUCET_FUNDING,
} from '../wrappers/mockStack';

// Deploys the mock USDT/USDC stables and the faucet, then wires the minters into
// the faucet. Ordering matters: the faucet address must be fixed before the minters
// (which are admined by it), so the faucet deploys first with minters unset.
export async function run(provider: NetworkProvider) {
  const sender = provider.sender();
  const admin = sender.address!;
  const ui = provider.ui();

  const walletCode = await compile('MockJettonWallet');
  const minterCode = await compile('MockJettonMinter');
  const faucetCode = await compile('Faucet');

  const faucetInit = { code: faucetCode, data: faucetData(admin) };
  const faucet = provider.open(new MockStackContract(contractAddress(0, faucetInit), faucetInit));
  if (!(await provider.isContractDeployed(faucet.address))) {
    await faucet.sendDeploy(sender, FAUCET_FUNDING);
    await provider.waitForDeploy(faucet.address);
  }

  const usdtInit = { code: minterCode, data: minterData(faucet.address, offchainContent('https://stonpool.test/usdt.json'), walletCode) };
  const usdcInit = { code: minterCode, data: minterData(faucet.address, offchainContent('https://stonpool.test/usdc.json'), walletCode) };
  const usdt = provider.open(new MockStackContract(contractAddress(0, usdtInit), usdtInit));
  const usdc = provider.open(new MockStackContract(contractAddress(0, usdcInit), usdcInit));
  for (const m of [usdt, usdc]) {
    if (!(await provider.isContractDeployed(m.address))) {
      await m.sendDeploy(sender, toNano('0.1'));
      await provider.waitForDeploy(m.address);
    }
  }

  await faucet.sendConfigure(sender, usdt.address, usdc.address);

  ui.write(`faucet: ${faucet.address.toString()}`);
  ui.write(`mUSDT:  ${usdt.address.toString()}`);
  ui.write(`mUSDC:  ${usdc.address.toString()}`);
}