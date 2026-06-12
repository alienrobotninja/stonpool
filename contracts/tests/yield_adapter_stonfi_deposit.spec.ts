import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, Builder } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER = 0x0f8a7ea5;
const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_CFG_ROUTER = 0x7e571001;
const OP_CFG_POOL = 0x7e571002;
const OP_CFG_ADAPTER = 0x10000074;

const ERR_WRONG_SENDER = 402;
const ERR_NOT_CONFIGURED = 802;

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

describe('C6 stonfi adapter deposit path (S4)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, routerCode: Cell, poolCode: Cell, adapterCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let usdtAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
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
  const lpBalance = (owner: Address) => bc.openContract(new Reader(lpWallet(owner))).getBalance();

  async function setup({ wire = true } = {}) {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    usdtAdmin = await bc.treasury('usdtAdmin');
    poolCore = await bc.treasury('poolCore');
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

    // router vault is the router's own USDT wallet; deposits fund it via the provide
    await router.sendConfigure(admin.getSender(), usdtWallet(router.address), pool.address);
    await pool.sendConfigure(admin.getSender(), router.address);

    if (wire) {
      await adapter.sendConfigure(admin.getSender(), ROLE.POOL_CORE, poolCore.address);
      await adapter.sendConfigure(admin.getSender(), ROLE.OWN_WALLET, usdtWallet(adapter.address));
      await adapter.sendConfigure(admin.getSender(), ROLE.ROUTER, router.address);
      await adapter.sendConfigure(admin.getSender(), ROLE.LP_WALLET, lpWallet(adapter.address));
      await adapter.sendConfigure(admin.getSender(), ROLE.STONFI_POOL, pool.address);
    }

    // fund pool-core with USDT so it can forward principal to the adapter
    await usdt.sendMint(usdtAdmin.getSender(), poolCore.address, 1_000_000n);
  }

  // pool-core forwards principal to the adapter as a tagged jetton transfer
  const deposit = (amount: bigint) =>
    bc.sendMessage(internal({
      from: poolCore.address, to: usdtWallet(poolCore.address), value: 3_000_000_000n,
      body: beginCell().storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(adapter.address)
        .storeAddress(poolCore.address).storeMaybeRef(null).storeCoins(2_500_000_000n)
        .storeUint(OP_DEPOSIT_PRINCIPAL, 32).endCell(),
    }));

  // synthetic transfer_notification straight to the adapter
  const notify = (amount: bigint, from: Address, fwd?: Builder) => {
    let b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(poolCore.address);
    if (fwd) b = b.storeBuilder(fwd);
    return bc.sendMessage(internal({ from, to: adapter.address, value: 1_000_000_000n, body: b.endCell() }));
  };

  it('tagged deposit provides to STON.fi, mints LP, tracks principal + lpBalance, reports', async () => {
    await setup();
    const res = await deposit(1000n);
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, op: OP_ADAPTER_REPORT, success: true });
    const d = await adapter.getData();
    expect(d.principal).toBe(1000n);
    expect(d.lpBalance).toBe(1000n); // bootstrap 1:1
    const p = await pool.getData();
    expect(p.reserve).toBe(1000n);
    expect(p.lpSupply).toBe(1000n);
    expect(await usdtBalance(router.address)).toBe(1000n); // underlying now in the router vault
    expect(await lpBalance(adapter.address)).toBe(1000n);
  });

  it('two deposits accumulate principal and lpBalance', async () => {
    await setup();
    await deposit(1000n);
    await deposit(500n);
    const d = await adapter.getData();
    expect(d.principal).toBe(1500n);
    expect(d.lpBalance).toBe(1500n);
    const p = await pool.getData();
    expect(p.reserve).toBe(1500n);
    expect(p.lpSupply).toBe(1500n);
  });

  it('notification from a foreign wallet reverts (402)', async () => {
    await setup();
    const fwd = beginCell().storeUint(OP_DEPOSIT_PRINCIPAL, 32);
    const res = await notify(1000n, stranger.address, fwd);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('untagged transfer from own wallet does not provide', async () => {
    await setup();
    const res = await notify(1000n, usdtWallet(adapter.address)); // no forward tag
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: true });
    expect(res.transactions).not.toHaveTransaction({ from: adapter.address, to: usdtWallet(adapter.address) });
    expect((await adapter.getData()).principal).toBe(0n);
  });

  it('deposit on an unconfigured adapter reverts (802)', async () => {
    await setup({ wire: false });
    const fwd = beginCell().storeUint(OP_DEPOSIT_PRINCIPAL, 32);
    const res = await notify(1000n, stranger.address, fwd);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });
});