import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, Builder } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_PROVIDE_LP = 0x37c096df;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_CFG_ROUTER = 0x7e571001;
const OP_CFG_POOL = 0x7e571002;

const ERR_UNAUTHORIZED = 401;
const ERR_WRONG_SENDER = 402;
const ERR_NOT_CONFIGURED = 810;
const ERR_SLIPPAGE = 811;

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

const provideFwd = (minLpOut: bigint, to: Address, bothPositive = false) =>
  beginCell().storeUint(OP_PROVIDE_LP, 32).storeCoins(minLpOut).storeAddress(to).storeBit(bothPositive);

const notif = (amount: bigint, from: Address, fwd?: Builder, queryId = 0) => {
  let b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(queryId, 64).storeCoins(amount).storeAddress(from);
  if (fwd) b = b.storeBuilder(fwd);
  return b.endCell();
};

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
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_router_data', [])).stack;
    return { admin: s.readAddress(), jettonWallet: s.readAddressOpt(), pool: s.readAddressOpt() };
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
  // direct provide_lp injection, for the auth-negative test
  async sendProvideLp(provider: ContractProvider, via: Sender, amount: bigint, to: Address, minLpOut: bigint) {
    await provider.internal(via, {
      value: 500_000_000n,
      body: beginCell().storeUint(OP_PROVIDE_LP, 32).storeUint(0, 64).storeCoins(amount).storeAddress(to).storeCoins(minLpOut).storeBit(false).endCell(),
    });
  }
  async getData(provider: ContractProvider) {
    const s = (await provider.get('get_pool_data', [])).stack;
    return { admin: s.readAddress(), router: s.readAddressOpt(), reserve: s.readBigNumber(), lpSupply: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock STON.fi provide path (S1)', () => {
  let bc: Blockchain;
  let walletCode: Cell, routerCode: Cell, poolCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let routerWallet: SandboxContract<TreasuryContract>; // stands in for the router's underlying vault wallet
  let stranger: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let router: SandboxContract<Router>;
  let pool: SandboxContract<Pool>;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    routerCode = loadCode('mock_stonfi_router');
    poolCode = loadCode('mock_stonfi_pool');
  });

  // LP wallets are minted with the pool as their master
  const lpWallet = (owner: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, pool.address) });
  const lpBalance = (owner: Address) => bc.openContract(new Reader(lpWallet(owner))).getBalance();

  async function setup(opts: { wire?: boolean } = {}) {
    const { wire = true } = opts;
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    routerWallet = await bc.treasury('routerWallet');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');

    const rData = beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).endCell();
    const rInit = { code: routerCode, data: rData };
    router = bc.openContract(new Router(contractAddress(0, rInit), rInit));
    await router.sendDeploy(admin.getSender());

    // pool storage: admin, router(null), reserve(0), lpSupply(0), lpWalletCode
    const pData = beginCell().storeAddress(admin.address).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell();
    const pInit = { code: poolCode, data: pData };
    pool = bc.openContract(new Pool(contractAddress(0, pInit), pInit));
    await pool.sendDeploy(admin.getSender());

    if (wire) {
      await router.sendConfigure(admin.getSender(), routerWallet.address, pool.address);
      await pool.sendConfigure(admin.getSender(), router.address);
    }
  }

  // simulate the router's vault wallet notifying it of an inbound provide_lp deposit
  const provide = (amount: bigint, to: Address, minLpOut = 1n, from: Address = routerWallet.address) =>
    bc.sendMessage(internal({ from, to: router.address, value: 1_000_000_000n, body: notif(amount, alice.address, provideFwd(minLpOut, to)) }));

  it('configure wires router and pool', async () => {
    await setup();
    const r = await router.getData();
    const p = await pool.getData();
    expect(r.jettonWallet!.equals(routerWallet.address)).toBe(true);
    expect(r.pool!.equals(pool.address)).toBe(true);
    expect(p.router!.equals(router.address)).toBe(true);
  });

  it('provide routes through to the pool and mints LP to the provider', async () => {
    await setup();
    const res = await provide(1000n, alice.address);
    expect(res.transactions).toHaveTransaction({ from: router.address, to: pool.address, op: OP_PROVIDE_LP, success: true });
    expect(res.transactions).toHaveTransaction({ from: pool.address, to: lpWallet(alice.address), op: OP_INTERNAL_TRANSFER, success: true });
    expect(await lpBalance(alice.address)).toBe(1000n); // bootstrap mint is 1:1
    const p = await pool.getData();
    expect(p.reserve).toBe(1000n);
    expect(p.lpSupply).toBe(1000n);
  });

  it('second provide mints LP proportional to reserve share', async () => {
    await setup();
    await provide(1000n, alice.address);
    await provide(500n, bob.address);
    expect(await lpBalance(bob.address)).toBe(500n); // 500 * 1000 / 1000
    const p = await pool.getData();
    expect(p.reserve).toBe(1500n);
    expect(p.lpSupply).toBe(1500n);
  });

  it('notification from a non-vault sender reverts (402)', async () => {
    await setup();
    const res = await provide(1000n, alice.address, 1n, stranger.address);
    expect(res.transactions).toHaveTransaction({ to: router.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('provide_lp injected by a non-router sender reverts (401)', async () => {
    await setup();
    const res = await pool.sendProvideLp(stranger.getSender(), 1000n, alice.address, 1n);
    expect(res.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('min_lp_out above the mintable amount reverts as slippage (811)', async () => {
    await setup();
    const res = await provide(1000n, alice.address, 1001n);
    expect(res.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_SLIPPAGE });
  });

  it('untagged notification is ignored: no pool message, no LP minted', async () => {
    await setup();
    const body = notif(1000n, alice.address, beginCell().storeUint(0xdeadbeef, 32));
    const res = await bc.sendMessage(internal({ from: routerWallet.address, to: router.address, value: 1_000_000_000n, body }));
    expect(res.transactions).toHaveTransaction({ to: router.address, success: true });
    expect(res.transactions).not.toHaveTransaction({ from: router.address, to: pool.address });
    expect((await pool.getData()).lpSupply).toBe(0n);
  });

  it('provide on an unconfigured router reverts (810)', async () => {
    await setup({ wire: false });
    const res = await provide(1000n, alice.address);
    expect(res.transactions).toHaveTransaction({ to: router.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });

  it('get_lp_quote exposes reserve and lp supply', async () => {
    await setup();
    await provide(2000n, alice.address);
    const s = await pool.getData();
    expect(s.reserve).toBe(2000n);
    expect(s.lpSupply).toBe(2000n);
  });
});