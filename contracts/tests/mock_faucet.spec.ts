import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_REQUEST = 0x10000052;
const OP_CONFIGURE = 0x10000053;
const ERR_NOT_FROM_ADMIN = 73;
const ERR_NOT_CONFIGURED = 800;
const ERR_RATE_LIMITED = 801;
const DRIP = 1000n;
const MINT_VALUE = 200_000_000n;
const COOLDOWN = 3600;
const T0 = 1_000_000;

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
    return { admin: s.readAddress(), usdt: s.readAddressOpt(), usdc: s.readAddressOpt(), drip: s.readBigNumber(), mintValue: s.readBigNumber(), cooldown: s.readBigNumber() };
  }
  async getLastClaim(provider: ContractProvider, owner: Address): Promise<bigint> {
    return (await provider.get('get_last_claim', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])).stack.readBigNumber();
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
  let user2: SandboxContract<TreasuryContract>;
  const content = beginCell().storeUint(0x01, 8).endCell();

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    faucetCode = loadCode('faucet');
  });

  let faucet: SandboxContract<Faucet>;
  let usdtMinter: Address;
  let usdcMinter: Address;

  async function deployStack(configure: boolean, faucetBalance = 5_000_000_000n) {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    stranger = await bc.treasury('stranger');
    user = await bc.treasury('user');
    user2 = await bc.treasury('user2');

    const fData = beginCell()
      .storeAddress(admin.address).storeAddress(null).storeAddress(null)
      .storeCoins(DRIP).storeCoins(MINT_VALUE).storeUint(COOLDOWN, 32).storeBit(false) // empty claims map
      .endCell();
    const fInit = { code: faucetCode, data: fData };
    faucet = bc.openContract(new Faucet(contractAddress(0, fInit), fInit));
    await faucet.sendDeploy(admin.getSender(), faucetBalance);

    const usdtData = beginCell().storeCoins(0).storeAddress(faucet.address).storeRef(content).storeRef(walletCode).endCell();
    const usdcData = beginCell().storeCoins(0).storeAddress(faucet.address).storeRef(beginCell().storeUint(0x02, 8).endCell()).storeRef(walletCode).endCell();
    const mk = (data: Cell) => bc.openContract(new (class implements Contract { address = contractAddress(0, { code: minterCode, data }); init = { code: minterCode, data };
      async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 100_000_000n, body: beginCell().endCell() }); } })());
    const usdtC = mk(usdtData), usdcC = mk(usdcData);
    await (usdtC as any).sendDeploy(admin.getSender());
    await (usdcC as any).sendDeploy(admin.getSender());
    usdtMinter = usdtC.address;
    usdcMinter = usdcC.address;

    if (configure) await faucet.sendConfigure(admin.getSender(), usdtMinter, usdcMinter);
  }

  const userWallet = (who: Address, minter: Address) =>
    bc.openContract(new Reader(contractAddress(0, { code: walletCode, data: walletData(0n, who, minter) })));
  const minterReader = (m: Address) => bc.openContract(new Reader(m));

  it('configure sets both minters and reports cooldown', async () => {
    await deployStack(false);
    await faucet.sendConfigure(admin.getSender(), usdtMinter, usdcMinter);
    const d = await faucet.getData();
    expect(d.usdt!.equals(usdtMinter)).toBe(true);
    expect(d.usdc!.equals(usdcMinter)).toBe(true);
    expect(d.cooldown).toBe(BigInt(COOLDOWN));
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

  it('request drips both stables and raises supply', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    expect(await userWallet(user.address, usdtMinter).getBalance()).toBe(DRIP);
    expect(await userWallet(user.address, usdcMinter).getBalance()).toBe(DRIP);
    expect(await minterReader(usdtMinter).getSupply()).toBe(DRIP);
    expect(await minterReader(usdcMinter).getSupply()).toBe(DRIP);
    expect(await faucet.getLastClaim(user.address)).toBe(BigInt(T0));
  });

  it('a second request within the cooldown reverts (801)', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    const res = await faucet.sendRequest(user.getSender());
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false, exitCode: ERR_RATE_LIMITED });
    expect(await userWallet(user.address, usdtMinter).getBalance()).toBe(DRIP); // not doubled
  });

  it('request succeeds again once the cooldown elapses', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    bc.now = T0 + COOLDOWN;
    await faucet.sendRequest(user.getSender());
    expect(await userWallet(user.address, usdtMinter).getBalance()).toBe(DRIP * 2n);
    expect(await faucet.getLastClaim(user.address)).toBe(BigInt(T0 + COOLDOWN));
  });

  it('cooldown is per-address: a different address can claim immediately', async () => {
    await deployStack(true);
    await faucet.sendRequest(user.getSender());
    const res = await faucet.sendRequest(user2.getSender());
    expect(res.transactions).not.toHaveTransaction({ to: faucet.address, success: false });
    expect(await userWallet(user2.address, usdtMinter).getBalance()).toBe(DRIP);
  });

  it('get_last_claim is 0 for an address that never claimed', async () => {
    await deployStack(true);
    expect(await faucet.getLastClaim(user.address)).toBe(0n);
  });

  it('an underfunded faucet cannot service a claim: it reverts and mints nothing (B11.S3)', async () => {
    // 0.2 TON deploy; the faucet pays 2 * MINT_VALUE = 0.4 TON of mint gas from its own
    // balance, so a low-value claim leaves it unable to fund both mints
    await deployStack(true, 200_000_000n);
    const supplyBefore = await minterReader(usdtMinter).getSupply();

    const res = await bc.sendMessage(internal({
      from: user.address, to: faucet.address, value: 50_000_000n,
      body: beginCell().storeUint(OP_REQUEST, 32).storeUint(0, 64).endCell(),
    }));

    // the claim aborts (action phase can't fund the mints), so it is atomic: nothing partial
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false });
    expect(await minterReader(usdtMinter).getSupply()).toBe(supplyBefore); // no tokens minted
    expect(await faucet.getLastClaim(user.address)).toBe(0n);              // cooldown not consumed
  });

  it('unknown opcode reverts', async () => {
    await deployStack(true);
    const res = await bc.sendMessage(internal({
      from: admin.address, to: faucet.address, value: 50_000_000n,
      body: beginCell().storeUint(0xdeadbeef, 32).endCell(),
    }));
    expect(res.transactions).toHaveTransaction({ to: faucet.address, success: false });
  });
});