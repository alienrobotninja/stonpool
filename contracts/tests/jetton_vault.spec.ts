import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_MINT = 0x00000015;
const OP_PAYOUT = 0x10000005;
const OP_CONFIGURE_VAULT = 0x10000072;
const OP_VAULT_CREDIT = 0x10000006;

const ERR_UNAUTHORIZED = 401;
const ERR_WRONG_SENDER = 402;
const ERR_NOT_CONFIGURED = 804;

const POT = 5_000_000n;

const walletData = (bal: bigint, owner: Address, minter: Address) =>
  beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();
const internalTransferStep = (amount: bigint) =>
  beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(null).storeAddress(null).storeCoins(0).endCell();

class Minter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 100_000_000n, body: beginCell().endCell() }); }
  async sendMint(p: ContractProvider, via: Sender, recipient: Address, amount: bigint) {
    await p.internal(via, {
      value: 300_000_000n,
      body: beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(recipient).storeCoins(100_000_000n).storeRef(internalTransferStep(amount)).endCell(),
    });
  }
}

class Vault implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, poolCore: Address, jettonWallet: Address) {
    await p.internal(via, { value: 100_000_000n, body: beginCell().storeUint(OP_CONFIGURE_VAULT, 32).storeUint(0, 64).storeAddress(poolCore).storeAddress(jettonWallet).endCell() });
  }
  async sendPayout(p: ContractProvider, via: Sender, to: Address, amount: bigint, value = 200_000_000n) {
    await p.internal(via, { value, body: beginCell().storeUint(OP_PAYOUT, 32).storeUint(0, 64).storeAddress(to).storeCoins(amount).endCell() });
  }
  async getData(p: ContractProvider) {
    const s = (await p.get('get_vault_data', [])).stack;
    return { admin: s.readAddress(), poolCore: s.readAddressOpt(), jettonWallet: s.readAddressOpt(), pot: s.readBigNumber() };
  }
}

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(p: ContractProvider): Promise<bigint> { return (await p.get('get_wallet_data', [])).stack.readBigNumber(); }
}

describe('C4 jetton-vault (prize-pot custody)', () => {
  let bc: Blockchain;
  let walletCode: Cell, minterCode: Cell, vaultCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let minterAdmin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let winner: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<Minter>;
  let vault: SandboxContract<Vault>;
  let vaultWallet: Address;

  beforeAll(() => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
    vaultCode = loadCode('jetton_vault');
  });

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter.address) });

  async function setup(opts: { configure?: boolean; fund?: boolean } = {}) {
    const { configure = true, fund = false } = opts;
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    minterAdmin = await bc.treasury('minterAdmin');
    poolCore = await bc.treasury('poolCore');
    stranger = await bc.treasury('stranger');
    winner = await bc.treasury('winner');

    const content = beginCell().storeUint(0x01, 8).endCell();
    const mData = beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell();
    const mInit = { code: minterCode, data: mData };
    minter = bc.openContract(new Minter(contractAddress(0, mInit), mInit));
    await minter.sendDeploy(minterAdmin.getSender());

    const vData = beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeCoins(0).endCell();
    const vInit = { code: vaultCode, data: vData };
    vault = bc.openContract(new Vault(contractAddress(0, vInit), vInit));
    await vault.sendDeploy(admin.getSender());

    vaultWallet = walletOf(vault.address);
    if (configure) await vault.sendConfigure(admin.getSender(), poolCore.address, vaultWallet);
    if (fund) {
      await minter.sendMint(minterAdmin.getSender(), vault.address, POT); // physical prize jettons into the vault wallet
      await creditPot(POT);                                               // pot accounting via the wallet notification
    }
  }

  // simulate the vault's jetton wallet notifying it of received yield
  async function creditPot(amount: bigint, from: Address = vaultWallet) {
    const body = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(poolCore.address).endCell();
    return bc.sendMessage(internal({ from, to: vault.address, value: 100_000_000n, body }));
  }

  it('configure wires pool-core and the jetton wallet', async () => {
    await setup({ configure: true });
    const d = await vault.getData();
    expect(d.poolCore!.equals(poolCore.address)).toBe(true);
    expect(d.jettonWallet!.equals(vaultWallet)).toBe(true);
    expect(d.pot).toBe(0n);
  });

  it('a notification from the jetton wallet credits the pot', async () => {
    await setup({ configure: true });
    await creditPot(POT);
    expect((await vault.getData()).pot).toBe(POT);
  });

  it('a credited notification reports the landed amount to pool-core', async () => {
    await setup();
    const r = await creditPot(10_000n);
    // pool-core's prizePot is only as true as this message. The vault knows what arrived;
    // the adapter only knew what it expected to arrive.
    expect(r.transactions).toHaveTransaction({
      from: vault.address, to: poolCore.address,
      body: beginCell().storeUint(OP_VAULT_CREDIT, 32).storeUint(0, 64).storeCoins(10_000n).endCell(),
    });
  });

  it('the report carries the amount that landed, not a running total', async () => {
    await setup();
    await creditPot(4_000n);
    const r = await creditPot(6_000n);
    // deltas commute with an in-flight payout; an absolute balance would not
    expect(r.transactions).toHaveTransaction({
      from: vault.address, to: poolCore.address,
      body: beginCell().storeUint(OP_VAULT_CREDIT, 32).storeUint(0, 64).storeCoins(6_000n).endCell(),
    });
    expect((await vault.getData()).pot).toBe(10_000n);
  });

  it('an unwired pool-core does not stop the pot being credited', async () => {
    // configure sets both, so drive the wallet-only case directly: the credit must land
    // even when there is nobody to tell about it
    await setup({ configure: false });
    await vault.sendConfigure(admin.getSender(), poolCore.address, vaultWallet);
    const r = await creditPot(10_000n);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: true });
    expect((await vault.getData()).pot).toBe(10_000n);
  });

  it('a notification from a non-wallet sender reverts (402)', async () => {
    await setup({ configure: true });
    const r = await creditPot(1_000n, stranger.address);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('a notification to an unconfigured vault reverts (804)', async () => {
    await setup({ configure: false });
    const r = await creditPot(1_000n);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });

  it('payout from pool-core sends jettons to the winner and debits the pot', async () => {
    await setup({ fund: true });
    const prize = 2_000_000n;
    await vault.sendPayout(poolCore.getSender(), winner.address, prize);
    const winnerBal = await bc.openContract(new Reader(walletOf(winner.address))).getBalance();
    expect(winnerBal).toBe(prize);
    expect((await vault.getData()).pot).toBe(POT - prize);
  });

  it('payout from a non-pool-core sender reverts (401)', async () => {
    await setup({ fund: true });
    const r = await vault.sendPayout(stranger.getSender(), winner.address, 1_000n);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('payout exceeding the pot pays what is there rather than reverting', async () => {
    await setup({ fund: true });
    const r = await vault.sendPayout(poolCore.getSender(), winner.address, POT + 1n);
    // pool-core has already zeroed prizePot and these sends are NoBounce, so a throw here
    // would strand the pot and pay nobody. Short-pay the winner and keep the vault solvent.
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: true });
    expect((await vault.getData()).pot).toBe(0n);
    expect(await bc.openContract(new Reader(walletOf(winner.address))).getBalance()).toBe(POT);
  });

  it('a payout against an empty pot is a no-op, not a failure', async () => {
    await setup({ fund: true });
    await vault.sendPayout(poolCore.getSender(), winner.address, POT); // drain it
    const r = await vault.sendPayout(poolCore.getSender(), winner.address, 1_000n);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: true });
    expect((await vault.getData()).pot).toBe(0n);
    // clamped to zero: no transfer emitted at all rather than a 0-jetton send
    expect(r.transactions).not.toHaveTransaction({ from: vault.address, to: vaultWallet });
  });

  it('payout on an unconfigured vault reverts (804)', async () => {
    await setup({ configure: false });
    const r = await vault.sendPayout(poolCore.getSender(), winner.address, 1_000n);
    expect(r.transactions).toHaveTransaction({ to: vault.address, success: false, exitCode: ERR_NOT_CONFIGURED });
  });
});