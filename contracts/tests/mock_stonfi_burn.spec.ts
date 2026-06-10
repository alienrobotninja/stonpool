import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, Builder } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_PROVIDE_LP = 0x37c096df;
const OP_BURN = 0x595f07bc;
const OP_BURN_NOTIFICATION = 0x7bdd97de;
const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_CFG_ROUTER = 0x7e571001;
const OP_CFG_POOL = 0x7e571002;
const OP_PAYOUT = 0x7e571003;
const OP_ACCRUE = 0x7e571004;

const ERR_UNAUTHORIZED = 401;
const ERR_WRONG_SENDER = 402;

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

const internalTransferStep = (amount: bigint) =>
  beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(null).storeAddress(null).storeCoins(0).endCell();

const provideFwd = (minLpOut: bigint, to: Address) =>
  beginCell().storeUint(OP_PROVIDE_LP, 32).storeCoins(minLpOut).storeAddress(to).storeBit(false);

class Minter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendMint(provider: ContractProvider, via: Sender, recipient: Address, amount: bigint) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(recipient).storeCoins(100_000_000n)
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
  async getLpWallet(provider: ContractProvider, owner: Address): Promise<Address> {
    return (await provider.get('get_lp_wallet', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])).stack.readAddress();
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock STON.fi burn/release path (S2)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, routerCode: Cell, poolCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let usdtAdmin: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let usdt: SandboxContract<Minter>;
  let router: SandboxContract<Router>;
  let pool: SandboxContract<Pool>;
  let vault: Address; // router's USDT wallet

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    routerCode = loadCode('mock_stonfi_router');
    poolCode = loadCode('mock_stonfi_pool');
  });

  const usdtWallet = (owner: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, usdt.address) });
  const lpWallet = (owner: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, pool.address) });
  const usdtBalance = (owner: Address) => bc.openContract(new Reader(usdtWallet(owner))).getBalance();
  const lpBalance = (owner: Address) => bc.openContract(new Reader(lpWallet(owner))).getBalance();

  async function setup() {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    usdtAdmin = await bc.treasury('usdtAdmin');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');

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

    // fund the router vault with underlying so it can pay out on burns
    await usdt.sendMint(usdtAdmin.getSender(), router.address, 10_000_000n);
    vault = usdtWallet(router.address);

    await router.sendConfigure(admin.getSender(), vault, pool.address);
    await pool.sendConfigure(admin.getSender(), router.address);
  }

  // simulate the vault notifying the router of an inbound provide (reserve accounting)
  const provide = (amount: bigint, to: Address) =>
    bc.sendMessage(internal({ from: vault, to: router.address, value: 1_000_000_000n, body:
      beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(to)
        .storeBuilder(provideFwd(1n, to)).endCell() }));

  // owner burns LP at their own LP wallet
  const burn = (owner: SandboxContract<TreasuryContract>, amount: bigint) =>
    bc.sendMessage(internal({ from: owner.address, to: lpWallet(owner.address), value: 1_500_000_000n, body:
      beginCell().storeUint(OP_BURN, 32).storeUint(0, 64).storeCoins(amount).storeAddress(owner.address).storeMaybeRef(null).endCell() }));

  it('burn releases proportional underlying and decrements reserve/lpSupply', async () => {
    await setup();
    await provide(1000n, alice.address);
    const res = await burn(alice, 400n);
    expect(res.transactions).toHaveTransaction({ to: pool.address, op: OP_BURN_NOTIFICATION, success: true });
    expect(res.transactions).toHaveTransaction({ from: pool.address, to: router.address, op: OP_PAYOUT, success: true });
    expect(await usdtBalance(alice.address)).toBe(400n);
    expect(await lpBalance(alice.address)).toBe(600n);
    const p = await pool.getData();
    expect(p.reserve).toBe(600n);
    expect(p.lpSupply).toBe(600n);
  });

  it('accrued yield makes each LP redeem for more underlying', async () => {
    await setup();
    await provide(1000n, alice.address);
    await pool.sendAccrue(admin.getSender(), 200n); // reserve 1000 -> 1200, lpSupply stays 1000
    await burn(alice, 1000n); // redeem all: 1000 * 1200 / 1000 = 1200
    expect(await usdtBalance(alice.address)).toBe(1200n);
    const p = await pool.getData();
    expect(p.reserve).toBe(0n);
    expect(p.lpSupply).toBe(0n);
  });

  it('partial burn after yield redeems a proportional share including yield', async () => {
    await setup();
    await provide(1000n, alice.address);
    await pool.sendAccrue(admin.getSender(), 200n); // reserve 1200, lp 1000
    await burn(alice, 500n); // 500 * 1200 / 1000 = 600
    expect(await usdtBalance(alice.address)).toBe(600n);
    const p = await pool.getData();
    expect(p.reserve).toBe(600n);
    expect(p.lpSupply).toBe(500n);
  });

  it('forged burn notification from a non-LP-wallet sender reverts (402)', async () => {
    await setup();
    await provide(1000n, alice.address);
    const body = beginCell().storeUint(OP_BURN_NOTIFICATION, 32).storeUint(0, 64).storeCoins(100n)
      .storeAddress(alice.address).storeAddress(null).endCell();
    const res = await bc.sendMessage(internal({ from: stranger.address, to: pool.address, value: 200_000_000n, body }));
    expect(res.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('PayOut from a non-pool sender reverts (401)', async () => {
    await setup();
    const body = beginCell().storeUint(OP_PAYOUT, 32).storeUint(0, 64).storeAddress(alice.address).storeCoins(100n).endCell();
    const res = await bc.sendMessage(internal({ from: stranger.address, to: router.address, value: 200_000_000n, body }));
    expect(res.transactions).toHaveTransaction({ to: router.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('accrueYield from a non-admin sender reverts (401)', async () => {
    await setup();
    const res = await pool.sendAccrue(stranger.getSender(), 100n);
    expect(res.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('get_lp_wallet matches the wallet the mint deploys to', async () => {
    await setup();
    await provide(1000n, alice.address);
    const reported = await pool.getLpWallet(alice.address);
    expect(reported.equals(lpWallet(alice.address))).toBe(true);
    expect(await lpBalance(alice.address)).toBe(1000n);
  });
});