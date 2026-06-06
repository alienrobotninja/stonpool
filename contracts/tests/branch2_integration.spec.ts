import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { MockStackContract, faucetData, minterData, offchainContent, walletData, DRIP } from '../wrappers/mockStack';

const OP_TRANSFER = 0x0f8a7ea5;
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_WITHDRAW = 0x10000032;
const OP_HARVEST = 0x10000033;
const OP_CONFIGURE_ADAPTER = 0x10000071;
const ERR_NOT_CONFIGURED = 802;
const YIELD_BPS = 500;

const adapterData = (admin: Address, yieldBps: number) =>
  beginCell().storeAddress(admin).storeAddress(null).storeAddress(null).storeUint(yieldBps, 16).storeCoins(0).endCell();

class Adapter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender, value: bigint) {
    await p.internal(via, { value, body: beginCell().endCell() });
  }
  async sendConfigure(p: ContractProvider, via: Sender, poolCore: Address, jettonWallet: Address) {
    await p.internal(via, { value: toNano('0.1'),
      body: beginCell().storeUint(OP_CONFIGURE_ADAPTER, 32).storeUint(0, 64).storeAddress(poolCore).storeAddress(jettonWallet).endCell() });
  }
  async sendWithdraw(p: ContractProvider, via: Sender, amount: bigint, to: Address) {
    await p.internal(via, { value: toNano('0.3'),
      body: beginCell().storeUint(OP_WITHDRAW, 32).storeUint(0, 64).storeCoins(amount).storeAddress(to).endCell() });
  }
  async sendHarvest(p: ContractProvider, via: Sender, to: Address) {
    await p.internal(via, { value: toNano('0.3'),
      body: beginCell().storeUint(OP_HARVEST, 32).storeUint(0, 64).storeAddress(to).endCell() });
  }
  async getDeployedValue(p: ContractProvider) {
    const s = (await p.get('get_deployed_value', [])).stack;
    return { principal: s.readBigNumber(), pending: s.readBigNumber() };
  }
}

// user-initiated TEP-74 transfer through the mock wallet; forward payload carries `tagOp`
class Wallet implements Contract {
  constructor(readonly address: Address) {}
  async sendTransfer(p: ContractProvider, via: Sender, amount: bigint, dest: Address, response: Address, tagOp: number) {
    await p.internal(via, {
      value: toNano('0.6'),
      body: beginCell()
        .storeUint(OP_TRANSFER, 32).storeUint(1, 64).storeCoins(amount)
        .storeAddress(dest).storeAddress(response).storeMaybeRef(null).storeCoins(toNano('0.1'))
        .storeUint(tagOp, 32) // forward payload remainder
        .endCell(),
    });
  }
  async getBalance(p: ContractProvider): Promise<bigint> {
    return (await p.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('branch 2 integration', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, faucetCode: Cell, adapterCode: Cell;
  let deployer: SandboxContract<TreasuryContract>;
  let adapterAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let user: SandboxContract<TreasuryContract>;
  let reserveProvider: SandboxContract<TreasuryContract>;
  let prize: SandboxContract<TreasuryContract>;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    faucetCode = loadCode('faucet');
    adapterCode = loadCode('mock_adapter');
  });

  let faucet: SandboxContract<MockStackContract>;
  let usdt: Address, usdc: Address;

  async function deployFaucet(funding: bigint) {
    const fInit = { code: faucetCode, data: faucetData(deployer.address) };
    faucet = bc.openContract(new MockStackContract(contractAddress(0, fInit), fInit));
    await faucet.sendDeploy(deployer.getSender(), funding);
    const mk = (c: Cell) => {
      const data = minterData(faucet.address, c, walletCode);
      const init = { code: minterCode, data };
      const m = bc.openContract(new MockStackContract(contractAddress(0, init), init));
      return m;
    };
    const u1 = mk(offchainContent('usdt')); const u2 = mk(offchainContent('usdc'));
    await u1.sendDeploy(deployer.getSender(), toNano('0.1'));
    await u2.sendDeploy(deployer.getSender(), toNano('0.1'));
    usdt = u1.address; usdc = u2.address;
    await faucet.sendConfigure(deployer.getSender(), usdt, usdc);
  }

  const stableWallet = (owner: Address, minter: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const wallet = (owner: Address, minter: Address) => bc.openContract(new Wallet(stableWallet(owner, minter)));

  async function deployAdapter(configure = true) {
    const aInit = { code: adapterCode, data: adapterData(adapterAdmin.address, YIELD_BPS) };
    const adapter = bc.openContract(new Adapter(contractAddress(0, aInit), aInit));
    await adapter.sendDeploy(adapterAdmin.getSender(), toNano('5'));
    const aWallet = stableWallet(adapter.address, usdt);
    if (configure) await adapter.sendConfigure(adapterAdmin.getSender(), poolCore.address, aWallet);
    return { adapter, aWallet };
  }

  beforeEach(async () => {
    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    adapterAdmin = await bc.treasury('adapterAdmin');
    poolCore = await bc.treasury('poolCore');
    user = await bc.treasury('user');
    reserveProvider = await bc.treasury('reserveProvider');
    prize = await bc.treasury('prize');
  });

  it('full loop: faucet -> deposit -> harvest -> withdraw', async () => {
    await deployFaucet(toNano('3'));
    const { adapter, aWallet } = await deployAdapter(true);

    // fund user + reserveProvider with USDT via the faucet
    await faucet.sendRequest(user.getSender());
    await faucet.sendRequest(reserveProvider.getSender());

    // reserve top-up (untagged) so harvest pays from reserve, not principal
    await wallet(reserveProvider.address, usdt).sendTransfer(reserveProvider.getSender(), DRIP, adapter.address, reserveProvider.address, 0);

    const deposit = DRIP / 2n;
    await wallet(user.address, usdt).sendTransfer(user.getSender(), deposit, adapter.address, user.address, OP_DEPOSIT_PRINCIPAL);

    const afterDeposit = await adapter.getDeployedValue();
    expect(afterDeposit.principal).toBe(deposit);
    const expectedYield = (deposit * BigInt(YIELD_BPS)) / 10_000n;
    expect(afterDeposit.pending).toBe(expectedYield);

    // harvest -> prize recipient gets yield from reserve, principal intact
    await adapter.sendHarvest(poolCore.getSender(), prize.address);
    expect(await wallet(prize.address, usdt).getBalance()).toBe(expectedYield);
    expect((await adapter.getDeployedValue()).principal).toBe(deposit);

    // withdraw principal back to the user
    await adapter.sendWithdraw(poolCore.getSender(), deposit, user.address);
    expect((await adapter.getDeployedValue()).principal).toBe(0n);
    // user's USDT wallet: DRIP - deposit (sent out) + deposit (returned) = DRIP
    expect(await wallet(user.address, usdt).getBalance()).toBe(DRIP);

    // adapter wallet left holding the reserve minus the paid yield
    expect(await bc.openContract(new Wallet(aWallet)).getBalance()).toBe(DRIP - expectedYield);
  });

  it('an underfunded faucet cannot pay drips', async () => {
    await deployFaucet(toNano('0.05')); // faucet left with too little TON to cover 2 x 0.2 mints
    // low-value request so it cannot top the faucet back over the mint cost
    await bc.sendMessage(internal({
      from: user.address, to: faucet.address, value: toNano('0.05'),
      body: beginCell().storeUint(0x10000052, 32).storeUint(0, 64).endCell(),
    }));
    await expect(wallet(user.address, usdt).getBalance()).rejects.toThrow(); // wallet never deployed
  });

  it('tagged deposit to an unconfigured adapter reverts and orphans the jettons', async () => {
    await deployFaucet(toNano('3'));
    const { adapter, aWallet } = await deployAdapter(false); // not configured
    await faucet.sendRequest(user.getSender());

    const deposit = DRIP / 2n;
    const res = await wallet(user.address, usdt).sendTransfer(user.getSender(), deposit, adapter.address, user.address, OP_DEPOSIT_PRINCIPAL);
    expect(res.transactions).toHaveTransaction({ to: adapter.address, success: false, exitCode: ERR_NOT_CONFIGURED });
    // jettons landed in the adapter's wallet but principal was never credited
    expect(await bc.openContract(new Wallet(aWallet)).getBalance()).toBe(deposit);
  });

  it('harvest without a reserve creates a principal shortfall', async () => {
    await deployFaucet(toNano('3'));
    const { adapter, aWallet } = await deployAdapter(true);
    await faucet.sendRequest(user.getSender());

    const deposit = DRIP / 2n;
    await wallet(user.address, usdt).sendTransfer(user.getSender(), deposit, adapter.address, user.address, OP_DEPOSIT_PRINCIPAL);

    const expectedYield = (deposit * BigInt(YIELD_BPS)) / 10_000n;
    await adapter.sendHarvest(poolCore.getSender(), prize.address);

    // accounting still says full principal, but the wallet paid yield out of principal jettons
    expect((await adapter.getDeployedValue()).principal).toBe(deposit);
    expect(await bc.openContract(new Wallet(aWallet)).getBalance()).toBe(deposit - expectedYield);
  });
});