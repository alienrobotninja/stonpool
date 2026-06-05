import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_WITHDRAW_PRINCIPAL = 0x10000032;
const OP_HARVEST_YIELD = 0x10000033;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_CONFIGURE = 0x10000071;
const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;

const ERR_UNAUTHORIZED = 401;
const ERR_WRONG_SENDER = 402;
const ERR_NOT_CONFIGURED = 802;
const ERR_INSUFFICIENT_PRINCIPAL = 803;

const YIELD_BPS = 500; // 5%
const P = 1_000_000n;  // principal
const R = 100_000n;    // yield reserve

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

const internalTransferStep = (amount: bigint) =>
  beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(null).storeAddress(null).storeCoins(0).endCell();

class Minter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 100_000_000n, body: beginCell().endCell() });
  }
  async sendMint(provider: ContractProvider, via: Sender, recipient: Address, amount: bigint) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(recipient).storeCoins(100_000_000n)
        .storeRef(internalTransferStep(amount)).endCell(),
    });
  }
}

class Adapter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, poolCore: Address, jettonWallet: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CONFIGURE, 32).storeUint(0, 64).storeAddress(poolCore).storeAddress(jettonWallet).endCell(),
    });
  }
  async sendWithdraw(provider: ContractProvider, via: Sender, amount: bigint, to: Address, queryId = 0) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeUint(queryId, 64).storeCoins(amount).storeAddress(to).endCell(),
    });
  }
  async sendHarvest(provider: ContractProvider, via: Sender, to: Address, queryId = 0) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_HARVEST_YIELD, 32).storeUint(queryId, 64).storeAddress(to).endCell(),
    });
  }
  async getDeployedValue(provider: ContractProvider) {
    const s = (await provider.get('get_deployed_value', [])).stack;
    return { principal: s.readBigNumber(), pending: s.readBigNumber() };
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_adapter_data', [])).stack;
    return { admin: s.readAddress(), poolCore: s.readAddressOpt(), jettonWallet: s.readAddressOpt(), yieldBps: s.readBigNumber(), principal: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock yield adapter (C7)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, adapterCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let minterAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let recipient: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<Minter>;
  let adapter: SandboxContract<Adapter>;
  let adapterWallet: Address;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    adapterCode = loadCode('mock_adapter');
  });

  const stableWallet = (owner: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter.address) });

  async function setup(opts: { configure?: boolean; fund?: boolean } = {}) {
    const { configure = true, fund = false } = opts;
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    minterAdmin = await bc.treasury('minterAdmin');
    poolCore = await bc.treasury('poolCore');
    stranger = await bc.treasury('stranger');
    recipient = await bc.treasury('recipient');

    const content = beginCell().storeUint(0x01, 8).endCell();
    const mData = beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell();
    const mInit = { code: minterCode, data: mData };
    minter = bc.openContract(new Minter(contractAddress(0, mInit), mInit));
    await minter.sendDeploy(minterAdmin.getSender());

    const aData = beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeUint(YIELD_BPS, 16).storeCoins(0).endCell();
    const aInit = { code: adapterCode, data: aData };
    adapter = bc.openContract(new Adapter(contractAddress(0, aInit), aInit));
    await adapter.sendDeploy(admin.getSender(), 5_000_000_000n);

    adapterWallet = stableWallet(adapter.address);
    if (configure) await adapter.sendConfigure(admin.getSender(), poolCore.address, adapterWallet);

    if (fund) {
      await minter.sendMint(minterAdmin.getSender(), adapter.address, P + R); // physical jettons
      await creditPrincipal(P); // accounting credit via tagged notification
    }
  }

  // simulate the adapter's jetton wallet notifying it of a tagged principal deposit
  async function creditPrincipal(amount: bigint, from: Address = adapterWallet, tag = true) {
    let b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(poolCore.address);
    if (tag) b = b.storeUint(OP_DEPOSIT_PRINCIPAL, 32);
    return bc.sendMessage(internal({ from, to: adapter.address, value: 150_000_000n, body: b.endCell() }));
  }

  it('configure wires pool-core and the jetton wallet', async () => {
    await setup({ configure: true });
    const d = await adapter.getData();
    expect(d.poolCore!.equals(poolCore.address)).toBe(true);
    expect(d.jettonWallet!.equals(adapterWallet)).toBe(true);
    expect(d.yieldBps).toBe(BigInt(YIELD_BPS));
  });

  it('tagged deposit credits principal and reports to pool-core', async () => {
    await setup({ configure: true });
    const res = await creditPrincipal(P);
    expect((await adapter.getDeployedValue()).principal).toBe(P);
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, op: OP_ADAPTER_REPORT });
  });

  it('untagged notification is a reserve top-up and does not change principal', async () => {
    await setup({ configure: true });
    await creditPrincipal(P, adapterWallet, false);
    expect((await adapter.getDeployedValue()).principal).toBe(0n);
  });

  it('notification from a non-wallet sender reverts (402)', async () => {
    await setup({ configure: true });
    const res = await creditPrincipal(P, stranger.address, true);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('pool-core withdraw sends principal to the target and decrements', async () => {
    await setup({ fund: true });
    const W = 400_000n;
    await adapter.sendWithdraw(poolCore.getSender(), W, recipient.address);
    expect(await bc.openContract(new Reader(stableWallet(recipient.address))).getBalance()).toBe(W);
    expect((await adapter.getDeployedValue()).principal).toBe(P - W);
  });

  it('withdraw from a non-pool-core sender reverts (401)', async () => {
    await setup({ fund: true });
    const res = await adapter.sendWithdraw(stranger.getSender(), 100_000n, recipient.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('withdraw exceeding principal reverts (803)', async () => {
    await setup({ fund: true });
    const res = await adapter.sendWithdraw(poolCore.getSender(), P + 1n, recipient.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_INSUFFICIENT_PRINCIPAL });
  });

  it('harvest pays synthetic yield from reserve and leaves principal intact', async () => {
    await setup({ fund: true });
    const expectedYield = (P * BigInt(YIELD_BPS)) / 10_000n;
    await adapter.sendHarvest(poolCore.getSender(), recipient.address, 7);
    expect(await bc.openContract(new Reader(stableWallet(recipient.address))).getBalance()).toBe(expectedYield);
    expect((await adapter.getDeployedValue()).principal).toBe(P);
  });

  it('harvest report carries the yield amount', async () => {
    await setup({ fund: true });
    const expectedYield = (P * BigInt(YIELD_BPS)) / 10_000n;
    const res = await adapter.sendHarvest(poolCore.getSender(), recipient.address, 7);
    const expBody = beginCell()
      .storeUint(OP_ADAPTER_REPORT, 32).storeUint(7, 64)
      .storeUint(OP_HARVEST_YIELD, 32).storeCoins(P).storeCoins(expectedYield).storeBit(true)
      .endCell();
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, body: expBody });
  });

  it('harvest from a non-pool-core sender reverts (401)', async () => {
    await setup({ fund: true });
    const res = await adapter.sendHarvest(stranger.getSender(), recipient.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('get_deployed_value reports principal and pending yield', async () => {
    await setup({ fund: true });
    const v = await adapter.getDeployedValue();
    expect(v.principal).toBe(P);
    expect(v.pending).toBe((P * BigInt(YIELD_BPS)) / 10_000n);
  });

  it('withdraw on an unconfigured adapter reverts (802)', async () => {
    await setup({ configure: false });
    const res = await adapter.sendWithdraw(poolCore.getSender(), 100_000n, recipient.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });

  it('unknown opcode reverts', async () => {
    await setup({ configure: true });
    const res = await bc.sendMessage(internal({ from: poolCore.address, to: adapter.address, value: 50_000_000n, body: beginCell().storeUint(0xdeadbeef, 32).endCell() }));
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false });
  });
});