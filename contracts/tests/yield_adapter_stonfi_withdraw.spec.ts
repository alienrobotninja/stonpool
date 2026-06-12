import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER = 0x0f8a7ea5;
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_WITHDRAW_PRINCIPAL = 0x10000032;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_ACCRUE = 0x7e571004;
const OP_CFG_ROUTER = 0x7e571001;
const OP_CFG_POOL = 0x7e571002;
const OP_CFG_ADAPTER = 0x10000074;

const ERR_UNAUTHORIZED = 401;
const ERR_INSUFFICIENT_PRINCIPAL = 803;

const ROLE = { POOL_CORE: 0, OWN_WALLET: 1, ROUTER: 2, LP_WALLET: 3, STONFI_POOL: 4 };

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

const internalTransferStep = (amount: bigint) =>
  beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(null).storeAddress(null).storeCoins(0).endCell();

class Minter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendMint(provider: ContractProvider, via: Sender, recipient: Address, amount: bigint) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(recipient).storeCoins(150_000_000n)
        .storeRef(internalTransferStep(amount)).endCell(),
    });
  }
}

class Router implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, jettonWallet: Address, pool: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CFG_ROUTER, 32).storeUint(0, 64).storeAddress(jettonWallet).storeAddress(pool).endCell(),
    });
  }
}

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, router: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CFG_POOL, 32).storeUint(0, 64).storeAddress(router).endCell(),
    });
  }
  async sendAccrue(provider: ContractProvider, via: Sender, amount: bigint) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_ACCRUE, 32).storeUint(0, 64).storeCoins(amount).endCell(),
    });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_pool_data', [])).stack;
    return { admin: s.readAddress(), router: s.readAddressOpt(), reserve: s.readBigNumber(), lpSupply: s.readBigNumber() };
  }
}

class Adapter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendConfigure(provider: ContractProvider, via: Sender, role: number, addr: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CFG_ADAPTER, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell(),
    });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_adapter_data', [])).stack;
    return { admin: s.readAddress(), principal: s.readBigNumber(), lpBalance: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('C6 stonfi adapter withdraw path (S5)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, routerCode: Cell, poolCode: Cell, adapterCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let usdtAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let user: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let usdt: SandboxContract<Minter>;
  let router: SandboxContract<Router>;
  let pool: SandboxContract<Pool>;
  let adapter: SandboxContract<Adapter>;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    routerCode = loadCode('mock_stonfi_router');
    poolCode = loadCode('mock_stonfi_pool');
    adapterCode = loadCode('yield_adapter_stonfi');
  });

  const usdtWallet = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, usdt.address) });
  const lpWallet = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, pool.address) });
  const usdtBalance = (owner: Address) => bc.openContract(new Reader(usdtWallet(owner))).getBalance();

  async function setup() {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    usdtAdmin = await bc.treasury('usdtAdmin');
    poolCore = await bc.treasury('poolCore');
    user = await bc.treasury('user');
    stranger = await bc.treasury('stranger');

    const content = beginCell().storeUint(0x01, 8).endCell();
    const mData = beginCell().storeCoins(0).storeAddress(usdtAdmin.address).storeRef(content).storeRef(walletCode).endCell();
    const mInit = { code: minterCode, data: mData };
    usdt = bc.openContract(new Minter(contractAddress(0, mInit), mInit));
    await usdt.sendDeploy(usdtAdmin.getSender());

    const rData = beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).endCell();
    const rInit = { code: routerCode, data: rData };
    router = bc.openContract(new Router(contractAddress(0, rInit), rInit));
    await router.sendDeploy(admin.getSender());

    const pData = beginCell().storeAddress(admin.address).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell();
    const pInit = { code: poolCode, data: pData };
    pool = bc.openContract(new Pool(contractAddress(0, pInit), pInit));
    await pool.sendDeploy(admin.getSender());

    const aData = beginCell().storeAddress(admin.address).storeCoins(0).storeCoins(0).storeUint(0, 16).storeBit(false).endCell();
    const aInit = { code: adapterCode, data: aData };
    adapter = bc.openContract(new Adapter(contractAddress(0, aInit), aInit));
    await adapter.sendDeploy(admin.getSender());

    await router.sendConfigure(admin.getSender(), usdtWallet(router.address), pool.address);
    await pool.sendConfigure(admin.getSender(), router.address);

    await adapter.sendConfigure(admin.getSender(), ROLE.POOL_CORE, poolCore.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.OWN_WALLET, usdtWallet(adapter.address));
    await adapter.sendConfigure(admin.getSender(), ROLE.ROUTER, router.address);
    await adapter.sendConfigure(admin.getSender(), ROLE.LP_WALLET, lpWallet(adapter.address));
    await adapter.sendConfigure(admin.getSender(), ROLE.STONFI_POOL, pool.address);

    await usdt.sendMint(usdtAdmin.getSender(), poolCore.address, 1_000_000n);
  }

  const deposit = (amount: bigint) =>
    bc.sendMessage(internal({
      from: poolCore.address, to: usdtWallet(poolCore.address), value: 3_000_000_000n,
      body: beginCell().storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(adapter.address)
        .storeAddress(poolCore.address).storeMaybeRef(null).storeCoins(2_500_000_000n)
        .storeUint(OP_DEPOSIT_PRINCIPAL, 32).endCell(),
    }));

  // pool-core asks the adapter to redeem `amount` of principal to `to`
  const withdraw = (amount: bigint, to: Address, from: Address = poolCore.address) =>
    bc.sendMessage(internal({
      from, to: adapter.address, value: 2_000_000_000n,
      body: beginCell().storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeUint(0, 64).storeCoins(amount).storeAddress(to).endCell(),
    }));

  it('full withdraw burns all LP and returns principal to the depositor', async () => {
    await setup();
    await deposit(1000n);
    const res = await withdraw(1000n, user.address);
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, op: OP_ADAPTER_REPORT, success: true });
    expect(await usdtBalance(user.address)).toBe(1000n);
    const d = await adapter.getData();
    expect(d.principal).toBe(0n);
    expect(d.lpBalance).toBe(0n);
    const p = await pool.getData();
    expect(p.reserve).toBe(0n);
    expect(p.lpSupply).toBe(0n);
  });

  it('partial withdraw redeems a proportional LP share', async () => {
    await setup();
    await deposit(1000n);
    await withdraw(400n, user.address);
    expect(await usdtBalance(user.address)).toBe(400n);
    const d = await adapter.getData();
    expect(d.principal).toBe(600n);
    expect(d.lpBalance).toBe(600n);
    const p = await pool.getData();
    expect(p.reserve).toBe(600n);
    expect(p.lpSupply).toBe(600n);
  });

  it('withdraw after yield carries the depositor their realized yield slice', async () => {
    await setup();
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 200n); // reserve 1000 -> 1200, lpSupply 1000
    // withdraw 500 principal: burn 1000*500/1000 = 500 LP, release 500*1200/1000 = 600
    await withdraw(500n, user.address);
    expect(await usdtBalance(user.address)).toBe(600n);
    const d = await adapter.getData();
    expect(d.principal).toBe(500n); // principal ledger drops by the requested amount only
    expect(d.lpBalance).toBe(500n);
    const p = await pool.getData();
    expect(p.reserve).toBe(600n);
    expect(p.lpSupply).toBe(500n);
  });

  it('withdraw from a non-pool-core sender reverts (401)', async () => {
    await setup();
    await deposit(1000n);
    const res = await withdraw(500n, user.address, stranger.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('withdraw above principal reverts (803)', async () => {
    await setup();
    await deposit(1000n);
    const res = await withdraw(1500n, user.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_INSUFFICIENT_PRINCIPAL });
  });
});