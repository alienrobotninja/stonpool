import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER = 0x0f8a7ea5;
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_HARVEST_YIELD = 0x10000033;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_HARVEST_STONFI = 0x10000035;
const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_ACCRUE = 0x7e571004;
const OP_CFG_ROUTER = 0x7e571001;
const OP_CFG_POOL = 0x7e571002;
const OP_CFG_ADAPTER = 0x10000074;
const OP_CFG_FEE = 0x10000075;

const ERR_UNAUTHORIZED = 401;
const ERR_INSUFFICIENT_PRINCIPAL = 803;

const ROLE = { POOL_CORE: 0, OWN_WALLET: 1, ROUTER: 2, LP_WALLET: 3, STONFI_POOL: 4 };

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

const internalTransferStep = (amount: bigint) =>
  beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(null).storeAddress(null).storeCoins(0).endCell();

// expected AdapterReportMsg body, to assert the exact harvested figure
const reportBody = (op: number, principal: bigint, yieldAmount: bigint) =>
  beginCell().storeUint(OP_ADAPTER_REPORT, 32).storeUint(0, 64)
    .storeUint(op, 32).storeCoins(principal).storeCoins(yieldAmount).storeBit(true).endCell();

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
  async sendFee(provider: ContractProvider, via: Sender, feeBps: number) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CFG_FEE, 32).storeUint(0, 64).storeUint(feeBps, 16).endCell(),
    });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_adapter_data', [])).stack;
    const admin = s.readAddress(); const principal = s.readBigNumber(); const lpBalance = s.readBigNumber();
    s.readAddressOpt(); s.readAddressOpt(); s.readAddressOpt(); s.readAddressOpt(); s.readAddressOpt();
    return { admin, principal, lpBalance, feeBps: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('C6 stonfi adapter harvest path (S6)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, routerCode: Cell, poolCode: Cell, adapterCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let usdtAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let vault: SandboxContract<TreasuryContract>;
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

  async function setup({ feeBps = 0 } = {}) {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    usdtAdmin = await bc.treasury('usdtAdmin');
    poolCore = await bc.treasury('poolCore');
    vault = await bc.treasury('vault');
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
    if (feeBps > 0) await adapter.sendFee(admin.getSender(), feeBps);

    await usdt.sendMint(usdtAdmin.getSender(), poolCore.address, 1_000_000n);
  }

  const deposit = (amount: bigint) =>
    bc.sendMessage(internal({
      from: poolCore.address, to: usdtWallet(poolCore.address), value: 3_000_000_000n,
      body: beginCell().storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(adapter.address)
        .storeAddress(poolCore.address).storeMaybeRef(null).storeCoins(2_500_000_000n)
        .storeUint(OP_DEPOSIT_PRINCIPAL, 32).endCell(),
    }));

  // keeper-attested harvest, as the off-chain indexer would size it from get_lp_quote
  const harvest = (lpToBurn: bigint, grossYield: bigint, from: Address = admin.address) =>
    bc.sendMessage(internal({
      from, to: adapter.address, value: 2_000_000_000n,
      body: beginCell().storeUint(OP_HARVEST_STONFI, 32).storeUint(0, 64)
        .storeCoins(lpToBurn).storeCoins(grossYield).storeAddress(vault.address).endCell(),
    }));

  // pool-core's epoch-advance harvest
  const epochHarvest = (from: Address = poolCore.address) =>
    bc.sendMessage(internal({
      from, to: adapter.address, value: 200_000_000n,
      body: beginCell().storeUint(OP_HARVEST_YIELD, 32).storeUint(0, 64).storeAddress(vault.address).endCell(),
    }));

  it('keeper harvest burns yield-LP to the vault and reports the yield, principal untouched', async () => {
    await setup();
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 250n); // reserve 1250, lpSupply 1000 -> 250 underlying of yield
    // backend sizes it: burn 200 LP -> releases 200*1250/1000 = 250 underlying
    const res = await harvest(200n, 250n);
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, body: reportBody(OP_HARVEST_YIELD, 1000n, 250n) });
    expect(await usdtBalance(vault.address)).toBe(250n);
    const d = await adapter.getData();
    expect(d.principal).toBe(1000n); // principal stays deployed
    expect(d.lpBalance).toBe(800n);
    const p = await pool.getData();
    expect(p.reserve).toBe(1000n); // back to principal-backing only
    expect(p.lpSupply).toBe(800n);
  });

  it('fee is netted from the reported yield but the full release reaches the vault', async () => {
    await setup({ feeBps: 100 }); // 1%
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 250n);
    const res = await harvest(200n, 250n); // gross 250, net 250 - 2 = 248
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, body: reportBody(OP_HARVEST_YIELD, 1000n, 248n) });
    expect(await usdtBalance(vault.address)).toBe(250n); // fee remainder socialized in the vault
    expect((await adapter.getData()).feeBps).toBe(100n);
  });

  it('principal still redeems in full after yield is harvested', async () => {
    await setup();
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 250n);
    await harvest(200n, 250n); // pool now reserve 1000 / lpSupply 800, adapter lp 800 / principal 1000
    const p = await pool.getData();
    expect(p.reserve).toBe(1000n);
    expect(p.lpSupply).toBe(800n);
    const d = await adapter.getData();
    expect(d.lpBalance).toBe(800n);
    expect(d.principal).toBe(1000n);
  });

  it('pool-core epoch harvest is a zero ack (real harvest is keeper-driven)', async () => {
    await setup();
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 250n);
    const res = await epochHarvest();
    expect(res.transactions).toHaveTransaction({ from: adapter.address, to: poolCore.address, body: reportBody(OP_HARVEST_YIELD, 1000n, 0n) });
    expect((await adapter.getData()).lpBalance).toBe(1000n); // nothing burned
  });

  it('harvest from a non-keeper sender reverts (401)', async () => {
    await setup();
    await deposit(1000n);
    await pool.sendAccrue(admin.getSender(), 250n);
    const res = await harvest(200n, 250n, stranger.address);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('harvest above held LP reverts (803)', async () => {
    await setup();
    await deposit(1000n);
    const res = await harvest(2000n, 250n);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_INSUFFICIENT_PRINCIPAL });
  });
});