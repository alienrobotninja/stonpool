import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const OP_INTERNAL_TRANSFER = 0x178d4519;
const ERR_NOT_FROM_OWNER = 705;

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

class Wallet implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 100_000_000n, body: beginCell().endCell() });
  }
  async sendInternalTransfer(provider: ContractProvider, via: Sender, amount: bigint) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell()
        .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
        .storeAddress(null).storeAddress(null).storeCoins(0)
        .endCell(),
    });
  }
  async sendAskToTransfer(provider: ContractProvider, via: Sender, amount: bigint, recipient: Address, response: Address) {
    await provider.internal(via, {
      value: 300_000_000n,
      body: beginCell()
        .storeUint(0x0f8a7ea5, 32).storeUint(1, 64).storeCoins(amount)
        .storeAddress(recipient).storeAddress(response).storeMaybeRef(null).storeCoins(0)
        .storeBit(false)
        .endCell(),
    });
  }
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock jetton wallet', () => {
  let bc: Blockchain;
  let owner: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let recipient: Address;
  let wallet: SandboxContract<Wallet>;

  beforeAll(async () => {
    const code = await compile('mock-jetton/jetton-wallet.tolk');
    bc = await Blockchain.create();
    owner = await bc.treasury('owner');
    minter = await bc.treasury('minter');
    stranger = await bc.treasury('stranger');
    recipient = randomAddress(0);

    const data = beginCell().storeCoins(0).storeAddress(owner.address).storeAddress(minter.address).endCell();
    const init = { code, data };
    wallet = bc.openContract(new Wallet(contractAddress(0, init), init));
    await wallet.sendDeploy(minter.getSender());
  }, 30000);

  it('mint via internal transfer from minter credits balance', async () => {
    await wallet.sendInternalTransfer(minter.getSender(), 1000n);
    expect(await wallet.getBalance()).toBe(1000n);
  });

  it('owner transfer decrements balance and emits internal transfer', async () => {
    const res = await wallet.sendAskToTransfer(owner.getSender(), 400n, recipient, owner.address);
    expect(res.transactions).toHaveTransaction({ from: wallet.address, op: OP_INTERNAL_TRANSFER });
    expect(await wallet.getBalance()).toBe(600n);
  });

  it('non-owner transfer reverts and leaves balance untouched', async () => {
    const res = await wallet.sendAskToTransfer(stranger.getSender(), 100n, recipient, stranger.address);
    expect(res.transactions).toHaveTransaction({ to: wallet.address, success: false, exitCode: ERR_NOT_FROM_OWNER });
    expect(await wallet.getBalance()).toBe(600n);
  });
});