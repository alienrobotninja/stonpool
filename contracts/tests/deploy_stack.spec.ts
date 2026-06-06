import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, contractAddress, Contract, ContractProvider, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { MockStackContract, faucetData, minterData, offchainContent, walletData, DRIP, FAUCET_FUNDING } from '../wrappers/mockStack';

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}
class FaucetReader implements Contract {
  constructor(readonly address: Address) {}
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_faucet_data', [])).stack;
    s.readAddress(); // admin
    return { usdt: s.readAddressOpt(), usdc: s.readAddressOpt() };
  }
}

describe('deploy mock stack', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, faucetCode: Cell;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    faucetCode = loadCode('faucet');
  });

  it('deploys faucet + stables in order, wires them, and drips on request', async () => {
    bc = await Blockchain.create();
    const admin = await bc.treasury('admin');
    const user = await bc.treasury('user');

    // 1. faucet first (minters unset)
    const faucetInit = { code: faucetCode, data: faucetData(admin.address) };
    const faucet = bc.openContract(new MockStackContract(contractAddress(0, faucetInit), faucetInit));
    await faucet.sendDeploy(admin.getSender(), FAUCET_FUNDING);

    // 2. stables admined by the faucet
    const usdtInit = { code: minterCode, data: minterData(faucet.address, offchainContent('https://stonpool.test/usdt.json'), walletCode) };
    const usdcInit = { code: minterCode, data: minterData(faucet.address, offchainContent('https://stonpool.test/usdc.json'), walletCode) };
    const usdt = bc.openContract(new MockStackContract(contractAddress(0, usdtInit), usdtInit));
    const usdc = bc.openContract(new MockStackContract(contractAddress(0, usdcInit), usdcInit));
    await usdt.sendDeploy(admin.getSender(), toNano('0.1'));
    await usdc.sendDeploy(admin.getSender(), toNano('0.1'));

    // 3. wire minters into the faucet
    await faucet.sendConfigure(admin.getSender(), usdt.address, usdc.address);

    const wired = await bc.openContract(new FaucetReader(faucet.address)).getData();
    expect(wired.usdt!.equals(usdt.address)).toBe(true);
    expect(wired.usdc!.equals(usdc.address)).toBe(true);

    // request drips both stables to the caller
    await faucet.sendRequest(user.getSender());
    const uWallet = (m: Address) => bc.openContract(new Reader(contractAddress(0, { code: walletCode, data: walletData(0n, user.address, m) })));
    expect(await uWallet(usdt.address).getBalance()).toBe(DRIP);
    expect(await uWallet(usdc.address).getBalance()).toBe(DRIP);
  });
});