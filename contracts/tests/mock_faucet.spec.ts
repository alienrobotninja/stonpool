import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { randomAddress } from '@ton/test-utils';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const OP_REQUEST = 0x10000052;
const OP_CONFIGURE = 0x10000053;
const ERR_NOT_FROM_ADMIN = 73;
const ERR_NOT_CONFIGURED = 800;
const DRIP = 1000n;
const MINT_VALUE = 200_000_000n;


const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

class Faucet implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, usdt: Address, usdc: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeAddress(usdt).storeAddress(usdc).endCell(),
    });
  }
  async sendRequest(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 300_000_000n, body: beginCell().storeUint(OP_REQUEST, 32).storeUint(0, 64).endCell() });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_faucet_data', [])).stack;
    return { admin: s.readAddress(), usdt: s.readAddressOpt(), usdc: s.readAddressOpt(), drip: s.readBigNumber(), mintValue: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
  async getSupply(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_jetton_data', [])).stack.readBigNumber();
  }
}

describe('mock faucet', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, faucetCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let user: SandboxContract<TreasuryContract>;
  const content = beginCell().storeUint(0x01, 8).endCell();

  beforeAll(async () => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    faucetCode = loadCode('faucet');
  }, 30000);

  let faucet: SandboxContract<Faucet>;
  let usdtMinter: Address;
  let usdcMinter: Address;

  async function deployStack(configure: boolean) {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    stranger = await bc.treasury('stranger');
    user = await bc.treasury('user');

    const fData = beginCell()
      .storeAddress(admin.address).storeAddress(null).storeAddress(null).storeCoins(DRIP).storeCoins(MINT_VALUE)
      .endCell();
    const fInit = { code: faucetCode, data: fData };
    faucet = bc.openContract(new Faucet(contractAddress(0, fInit), fInit));
    await faucet.sendDeploy(admin.getSender(), 5_000_000_000n); // fund the faucet

    const mkMinter = (c: Cell) => {
      const data = beginCell().storeCoins(0).storeAddress(faucet.address).storeRef(c).storeRef(walletCode).endCell();
      return contractAddress(0, { code: minterCode, data });
    };
    const usdtData = beginCell().storeCoins(0).storeAddress(faucet.address).storeRef(content).storeRef(walletCode).endCell();
    const usdcData = beginCell().storeCoins(0).storeAddress(faucet.address).storeRef(beginCell().storeUint(0x02, 8).endCell()).storeRef(walletCode).endCell();
    const usdtC = bc.openContract(new (class implements Contract { address = contractAddress(0, { code: minterCode, data: usdtData }); init = { code: minterCode, data: usdtData };
      async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 100_000_000n, body: beginCell().endCell() }); } })());
    const usdcC = bc.openContract(new (class implements Contract { address = contractAddress(0, { code: minterCode, data: usdcData }); init = { code: minterCode, data: usdcData };
      async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 100_000_000n, body: beginCell().endCell() }); } })());
    await (usdtC as any).sendDeploy(admin.getSender());
    await (usdcC as any).sendDeploy(admin.getSender());
    usdtMinter = usdtC.address;
    usdcMinter = usdcC.address;

    if (configure) await faucet.sendConfigure(admin.getSender(), usdtMinter, usdcMinter);
  }

  const userWallet = (minter: Address) =>
    bc.openContract(new Reader(contractAddress(0, { code: walletCode, data: walletData(0n, user.address, minter) })));
  const minterReader = (m: Address) => bc.openContract(new Reader(m));

  it('configure sets both minters (admin only)', async () => {
    await deployStack(false);
    await faucet.sendConfigure(admin.getSender(), usdtMinter, usdcMinter);
    const d = await faucet.getData();
    expect(d.usdt!.equals(usdtMinter)).toBe(true);
    expect(d.usdc!.equals(usdcMinter)).toBe(true);
  });

  it('configure from non-admin reverts (73)', async () => {
    await deployStack(false);
    const res = await faucet.sendConfigure(stranger.getSender(), usdtMinter, usdcMinter);
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
  });

  it('request before configure reverts (800)', async () => {
    await deployStack(false);
    const res = await faucet.sendRequest(user.getSender());
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });

  it('request drips both stables to the sender and raises supply', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    expect(await userWallet(usdtMinter).getBalance()).toBe(DRIP);
    expect(await userWallet(usdcMinter).getBalance()).toBe(DRIP);
    expect(await minterReader(usdtMinter).getSupply()).toBe(DRIP);
    expect(await minterReader(usdcMinter).getSupply()).toBe(DRIP);
  });

  it('repeated requests accumulate (unthrottled until step 4)', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    await faucet.sendRequest(user.getSender());
    expect(await userWallet(usdtMinter).getBalance()).toBe(DRIP * 2n);
  });

  it('unknown opcode reverts', async () => {
    await deployStack(true);
    const { internal } = await import('@ton/sandbox');
    const res = await bc.sendMessage(internal({
      from: admin.address, to: faucet.address, value: 50_000_000n,
      body: beginCell().storeUint(0xdeadbeef, 32).endCell(),
    }));
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false });
  });
});