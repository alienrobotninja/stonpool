import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, Contract, ContractProvider, contractAddress, Sender } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_CFG_POOL = 0x7e571002;
const OP_PROVIDE_LP = 0x37c096df;
const OP_SIMULATE_LOSS = 0x7e571005;
const ERR_UNAUTHORIZED = 401;

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();

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
  async sendProvideLp(provider: ContractProvider, via: Sender, amount: bigint, to: Address, minLpOut = 1n) {
    await provider.internal(via, {
      value: 500_000_000n,
      body: beginCell().storeUint(OP_PROVIDE_LP, 32).storeUint(0, 64).storeCoins(amount).storeAddress(to).storeCoins(minLpOut).storeBit(false).endCell(),
    });
  }
  async sendSimulateLoss(provider: ContractProvider, via: Sender, amount: bigint) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_SIMULATE_LOSS, 32).storeUint(0, 64).storeCoins(amount).endCell(),
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

describe('depeg socializes loss across LP holders (B11.S1)', () => {
  let bc: Blockchain;
  let walletCode: Cell, poolCode: Cell;
  let admin: SandboxContract<TreasuryContract>; // also the configured router, so it can inject provide_lp
  let stranger: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let pool: SandboxContract<Pool>;

  const lpWallet = (owner: Address) =>
    contractAddress(0, { code: walletCode, data: walletData(0n, owner, pool.address) });
  const lpBalance = (owner: Address) => bc.openContract(new Reader(lpWallet(owner))).getBalance();

  // what a withdrawal would pay: the LP burn releases lpBal * reserve / lpSupply
  const redeemable = async (owner: Address) => {
    const lp = await lpBalance(owner);
    const { reserve, lpSupply } = await pool.getData();
    return (lp * reserve) / lpSupply;
  };

  beforeEach(async () => {
    walletCode = loadCode('wallet');
    poolCode = loadCode('mock_stonfi_pool');
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');

    const pData = beginCell().storeAddress(admin.address).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell();
    const pInit = { code: poolCode, data: pData };
    pool = bc.openContract(new Pool(contractAddress(0, pInit), pInit));
    await pool.sendDeploy(admin.getSender());
    await pool.sendConfigure(admin.getSender(), admin.address); // admin doubles as the router for injection

    await pool.sendProvideLp(admin.getSender(), 1000n, alice.address); // bootstrap 1:1 -> lpA 1000
    await pool.sendProvideLp(admin.getSender(), 500n, bob.address); // 500 * 1000/1000 -> lpB 500
  });

  it('redemption rate drops and the shortfall is shared in proportion to LP held', async () => {
    expect(await lpBalance(alice.address)).toBe(1000n);
    expect(await lpBalance(bob.address)).toBe(500n);
    const redA0 = await redeemable(alice.address); // 1000
    const redB0 = await redeemable(bob.address); // 500

    await pool.sendSimulateLoss(admin.getSender(), 300n); // reserve 1500 -> 1200

    const { reserve, lpSupply } = await pool.getData();
    expect(reserve).toBe(1200n);
    expect(lpSupply).toBe(1500n); // supply untouched -> each LP redeems for less

    const redA1 = await redeemable(alice.address); // 1000 * 1200/1500 = 800
    const redB1 = await redeemable(bob.address); // 500 * 1200/1500 = 400
    expect(redA1).toBe(800n);
    expect(redB1).toBe(400n);

    const lossA = redA0 - redA1; // 200
    const lossB = redB0 - redB1; // 100
    expect(lossA * 500n).toBe(lossB * 1000n); // lossA/lossB == lpA/lpB (2:1)
    expect(redA1 + redB1).toBe(reserve); // no value created or destroyed beyond the loss
  });

  it('only the admin can simulate a loss', async () => {
    const res = await pool.sendSimulateLoss(stranger.getSender(), 100n);
    expect(res.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getData()).reserve).toBe(1500n);
  });

  it('a loss larger than the reserve floors at zero instead of underflowing', async () => {
    await pool.sendSimulateLoss(admin.getSender(), 5000n);
    expect((await pool.getData()).reserve).toBe(0n);
  });
});