import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const OP_TRANSFER = 0x0f8a7ea5;
const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_BURN = 0x595f07bc;
const OP_BURN_NOTIFICATION = 0x7bdd97de;

const ERR_WRONG_WORKCHAIN = 333;
const ERR_NOT_FROM_OWNER = 705;
const ERR_NOT_ENOUGH_BALANCE = 706;
const ERR_INVALID_WALLET = 707;
const ERR_INVALID_PAYLOAD = 708;
const ERR_NOT_ENOUGH_TON = 709;

const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');
const STDLIB_DIR = join(dirname(require.resolve('@ton/tolk-js')), 'tolk-stdlib');

async function compile(entry: string): Promise<Cell> {
  const res = await runTolkCompiler({
    entrypointFileName: entry,
    fsReadCallback: (p) =>
      p.startsWith('@stdlib/')
        ? readFileSync(join(STDLIB_DIR, p.slice('@stdlib/'.length) + '.tolk'), 'utf-8')
        : readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
  });
  if (res.status !== 'ok') throw new Error(res.message);
  return Cell.fromBase64(res.codeBoc64);
}

function walletData(balance: bigint, owner: Address, minter: Address): Cell {
  return beginCell().storeCoins(balance).storeAddress(owner).storeAddress(minter).endCell();
}

class Wallet implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 100_000_000n, body: beginCell().endCell() });
  }
  async sendInternalTransfer(provider: ContractProvider, via: Sender, amount: bigint, initiator: Address | null) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell()
        .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
        .storeAddress(initiator).storeAddress(null).storeCoins(0)
        .endCell(),
    });
  }
  async sendTransfer(
    provider: ContractProvider, via: Sender, amount: bigint, recipient: Address, response: Address,
    opts: { forwardTon?: bigint; value?: bigint; emptyPayload?: boolean } = {},
  ) {
    const { forwardTon = 0n, value = 300_000_000n, emptyPayload = false } = opts;
    let b = beginCell()
      .storeUint(OP_TRANSFER, 32).storeUint(1, 64).storeCoins(amount)
      .storeAddress(recipient).storeAddress(response).storeMaybeRef(null).storeCoins(forwardTon);
    if (!emptyPayload) b = b.storeBit(false);
    await provider.internal(via, { value, body: b.endCell() });
  }
  async sendBurn(provider: ContractProvider, via: Sender, amount: bigint, response: Address) {
    await provider.internal(via, {
      value: 200_000_000n,
      body: beginCell()
        .storeUint(OP_BURN, 32).storeUint(1, 64).storeCoins(amount)
        .storeAddress(response).storeMaybeRef(null)
        .endCell(),
    });
  }
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock jetton wallet', () => {
  let bc: Blockchain;
  let code: Cell;
  let owner: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;

  beforeAll(async () => {
    code = await compile('mock-jetton/jetton-wallet.tolk');
  }, 30000);

  beforeEach(async () => {
    bc = await Blockchain.create();
    owner = await bc.treasury('owner');
    minter = await bc.treasury('minter');
    stranger = await bc.treasury('stranger');
  });

  // canonical (balance-0) deploy, then mint to fund — keeps the wallet at its derived address
  async function freshWallet(startBalance: bigint): Promise<SandboxContract<Wallet>> {
    const init = { code, data: walletData(0n, owner.address, minter.address) };
    const w = bc.openContract(new Wallet(contractAddress(0, init), init));
    await w.sendDeploy(minter.getSender());
    if (startBalance > 0n) await w.sendInternalTransfer(minter.getSender(), startBalance, null);
    return w;
  }

  function derivedWalletAddress(ownerAddr: Address): Address {
    return contractAddress(0, { code, data: walletData(0n, ownerAddr, minter.address) });
  }

  it('mint via internal transfer from minter credits balance', async () => {
    const w = await freshWallet(0n);
    await w.sendInternalTransfer(minter.getSender(), 1000n, null);
    expect(await w.getBalance()).toBe(1000n);
  });

  it('owner transfer decrements balance and emits internal transfer', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(owner.getSender(), 400n, randomAddress(0), owner.address);
    expect(res.transactions).toHaveTransaction({ from: w.address, op: OP_INTERNAL_TRANSFER });
    expect(await w.getBalance()).toBe(600n);
  });

  it('onward internal transfer targets the off-chain-derived recipient wallet (address parity)', async () => {
    const w = await freshWallet(1000n);
    const recipient = randomAddress(0);
    const res = await w.sendTransfer(owner.getSender(), 400n, recipient, owner.address);
    expect(res.transactions).toHaveTransaction({
      from: w.address,
      to: derivedWalletAddress(recipient),
      op: OP_INTERNAL_TRANSFER,
    });
  });

  it('transfer with forward ton delivers a notification to the recipient owner', async () => {
    const w = await freshWallet(1000n);
    const recipient = randomAddress(0);
    const res = await w.sendTransfer(owner.getSender(), 400n, recipient, owner.address, {
      forwardTon: 50_000_000n,
      value: 500_000_000n,
    });
    expect(res.transactions).toHaveTransaction({ to: recipient, op: OP_TRANSFER_NOTIFICATION });
  });

  it('owner burn decrements balance and notifies the minter', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendBurn(owner.getSender(), 300n, owner.address);
    expect(res.transactions).toHaveTransaction({ from: w.address, to: minter.address, op: OP_BURN_NOTIFICATION });
    expect(await w.getBalance()).toBe(700n);
  });

  it('non-owner transfer reverts (705) and leaves balance untouched', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(stranger.getSender(), 100n, randomAddress(0), stranger.address);
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_NOT_FROM_OWNER });
    expect(await w.getBalance()).toBe(1000n);
  });

  it('transfer exceeding balance reverts (706)', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(owner.getSender(), 2000n, randomAddress(0), owner.address);
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_NOT_ENOUGH_BALANCE });
    expect(await w.getBalance()).toBe(1000n);
  });

  it('transfer with insufficient ton reverts (709)', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(owner.getSender(), 100n, randomAddress(0), owner.address, { value: 20_000_000n });
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_NOT_ENOUGH_TON });
  });

  it('transfer to a non-basechain recipient reverts (333)', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(owner.getSender(), 100n, randomAddress(-1), owner.address);
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_WRONG_WORKCHAIN });
  });

  it('transfer with empty forward payload reverts (708)', async () => {
    const w = await freshWallet(1000n);
    const res = await w.sendTransfer(owner.getSender(), 100n, randomAddress(0), owner.address, { emptyPayload: true });
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_INVALID_PAYLOAD });
  });

  it('internal transfer from a non-minter, non-sibling sender reverts (707)', async () => {
    const w = await freshWallet(1000n);
    // stranger is neither the minter nor the derived wallet of `initiator`
    const res = await bc.sendMessage(internal({
      from: stranger.address, to: w.address, value: 100_000_000n,
      body: beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(100n)
        .storeAddress(owner.address).storeAddress(null).storeCoins(0).endCell(),
    }));
    expect(res.transactions).toHaveTransaction({ to: w.address, success: false, exitCode: ERR_INVALID_WALLET });
    expect(await w.getBalance()).toBe(1000n);
  });

  it('bounced internal transfer restores balance', async () => {
    const w = await freshWallet(1000n);
    const bouncedBody = beginCell()
      .storeUint(0xffffffff, 32)            // bounce prefix
      .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(300n)
      .endCell();
    await bc.sendMessage(internal({
      from: minter.address, to: w.address, value: 50_000_000n, bounced: true, body: bouncedBody,
    }));
    expect(await w.getBalance()).toBe(1300n);
  });
});