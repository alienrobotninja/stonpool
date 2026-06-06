import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { randomAddress } from '@ton/test-utils';
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

const OP_MINT = 0x00000015;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_BURN_NOTIFICATION = 0x7bdd97de;
const OP_REQUEST_WALLET_ADDRESS = 0x2c76b973;
const OP_RESPONSE_WALLET_ADDRESS = 0xd1735400;
const OP_CHANGE_ADMIN = 0x00000003;
const OP_CHANGE_CONTENT = 0x00000004;

const ERR_NOT_FROM_ADMIN = 73;
const ERR_UNAUTHORIZED_BURN = 74;
const ERR_NOT_ENOUGH_AMOUNT_TO_RESPOND = 75;
const ERR_INVALID_PAYLOAD = 708;


function walletData(balance: bigint, owner: Address, minter: Address): Cell {
  return beginCell().storeCoins(balance).storeAddress(owner).storeAddress(minter).endCell();
}

function internalTransferStep(amount: bigint, initiator: Address | null): Cell {
  return beginCell()
    .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
    .storeAddress(initiator).storeAddress(null).storeCoins(0)
    .endCell();
}

class Minter implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender) {
    await provider.internal(via, { value: 200_000_000n, body: beginCell().endCell() });
  }
  async sendMint(provider: ContractProvider, via: Sender, recipient: Address, amount: bigint,
                 opts: { initiator?: Address | null; tonAmount?: bigint; value?: bigint } = {}) {
    const { initiator = null, tonAmount = 100_000_000n, value = 300_000_000n } = opts;
    await provider.internal(via, {
      value,
      body: beginCell()
        .storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(recipient).storeCoins(tonAmount)
        .storeRef(internalTransferStep(amount, initiator))
        .endCell(),
    });
  }
  async sendChangeAdmin(provider: ContractProvider, via: Sender, newAdmin: Address) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CHANGE_ADMIN, 32).storeUint(0, 64).storeAddress(newAdmin).endCell(),
    });
  }
  async sendChangeContent(provider: ContractProvider, via: Sender, content: Cell) {
    await provider.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_CHANGE_CONTENT, 32).storeUint(0, 64).storeRef(content).endCell(),
    });
  }
  async sendRequestWalletAddress(provider: ContractProvider, via: Sender, owner: Address, includeOwner: boolean, value: bigint) {
    await provider.internal(via, {
      value,
      body: beginCell()
        .storeUint(OP_REQUEST_WALLET_ADDRESS, 32).storeUint(0, 64).storeAddress(owner).storeBit(includeOwner)
        .endCell(),
    });
  }
  async getSupply(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_jetton_data', [])).stack.readBigNumber();
  }
  async getJettonData(provider: ContractProvider) {
    const s = (await provider.get('get_jetton_data', [])).stack;
    return { supply: s.readBigNumber(), mintable: s.readBoolean(), admin: s.readAddress(), content: s.readCell(), walletCode: s.readCell() };
  }
  async getWalletAddress(provider: ContractProvider, owner: Address): Promise<Address> {
    return (await provider.get('get_wallet_address', [{ type: 'slice', cell: beginCell().storeAddress(owner).endCell() }])).stack.readAddress();
  }
}

class Wallet implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async getBalance(provider: ContractProvider): Promise<bigint> {
    return (await provider.get('get_wallet_data', [])).stack.readBigNumber();
  }
}

describe('mock jetton minter', () => {
  let bc: Blockchain;
  let walletCode: Cell;
  let minterCode: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let minter: SandboxContract<Minter>;
  const content = beginCell().storeUint(0x01, 8).endCell();

  beforeAll(async () => {
    walletCode = loadCode('wallet');
    minterCode = loadCode('minter');
  }, 30000);

  beforeEach(async () => {
    bc = await Blockchain.create();
    admin = await bc.treasury('admin');
    stranger = await bc.treasury('stranger');
    const data = beginCell().storeCoins(0).storeAddress(admin.address).storeRef(content).storeRef(walletCode).endCell();
    const init = { code: minterCode, data };
    minter = bc.openContract(new Minter(contractAddress(0, init), init));
    await minter.sendDeploy(admin.getSender());
  });

  function derivedWallet(owner: Address): Address {
    return contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter.address) });
  }

  it('admin mint increases supply and credits the recipient wallet', async () => {
    const recipient = randomAddress(0);
    await minter.sendMint(admin.getSender(), recipient, 1000n);
    expect(await minter.getSupply()).toBe(1000n);
    const w = bc.openContract(new Wallet(derivedWallet(recipient), { code: walletCode, data: walletData(0n, recipient, minter.address) }));
    expect(await w.getBalance()).toBe(1000n);
  });

  it('non-admin mint reverts (73)', async () => {
    const res = await minter.sendMint(stranger.getSender(), randomAddress(0), 1000n);
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
    expect(await minter.getSupply()).toBe(0n);
  });

  it('mint with non-null transferInitiator reverts (708)', async () => {
    const res = await minter.sendMint(admin.getSender(), randomAddress(0), 1000n, { initiator: admin.address });
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_INVALID_PAYLOAD });
  });

  it('mint of zero reverts (708)', async () => {
    const res = await minter.sendMint(admin.getSender(), randomAddress(0), 0n);
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_INVALID_PAYLOAD });
  });

  it('burn notification from the derived wallet decreases supply', async () => {
    const burnInitiator = randomAddress(0);
    await minter.sendMint(admin.getSender(), burnInitiator, 1000n);
    const fromWallet = derivedWallet(burnInitiator);
    await bc.sendMessage(internal({
      from: fromWallet, to: minter.address, value: 100_000_000n,
      body: beginCell().storeUint(OP_BURN_NOTIFICATION, 32).storeUint(0, 64).storeCoins(300n)
        .storeAddress(burnInitiator).storeAddress(null).endCell(),
    }));
    expect(await minter.getSupply()).toBe(700n);
  });

  it('burn notification from a non-wallet sender reverts (74)', async () => {
    await minter.sendMint(admin.getSender(), randomAddress(0), 1000n);
    const res = await bc.sendMessage(internal({
      from: stranger.address, to: minter.address, value: 100_000_000n,
      body: beginCell().storeUint(OP_BURN_NOTIFICATION, 32).storeUint(0, 64).storeCoins(300n)
        .storeAddress(randomAddress(0)).storeAddress(null).endCell(),
    }));
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_UNAUTHORIZED_BURN });
  });

  it('change admin updates data and transfers mint rights', async () => {
    const newAdmin = await bc.treasury('newAdmin');
    await minter.sendChangeAdmin(admin.getSender(), newAdmin.address);
    expect((await minter.getJettonData()).admin.equals(newAdmin.address)).toBe(true);
    // old admin can no longer mint
    const old = await minter.sendMint(admin.getSender(), randomAddress(0), 1000n);
    expect(old.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
    // new admin can
    await minter.sendMint(newAdmin.getSender(), randomAddress(0), 1000n);
    expect(await minter.getSupply()).toBe(1000n);
  });

  it('change admin from non-admin reverts (73)', async () => {
    const res = await minter.sendChangeAdmin(stranger.getSender(), stranger.address);
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_NOT_FROM_ADMIN });
  });

  it('change content updates jetton data', async () => {
    const newContent = beginCell().storeUint(0x02, 8).endCell();
    await minter.sendChangeContent(admin.getSender(), newContent);
    expect((await minter.getJettonData()).content.equals(newContent)).toBe(true);
  });

  it('discovery returns the correct wallet address (no owner)', async () => {
    const owner = randomAddress(0);
    const res = await minter.sendRequestWalletAddress(stranger.getSender(), owner, false, 100_000_000n);
    const exp = beginCell()
      .storeUint(OP_RESPONSE_WALLET_ADDRESS, 32).storeUint(0, 64)
      .storeAddress(derivedWallet(owner)).storeMaybeRef(null)
      .endCell();
    expect(res.transactions).toHaveTransaction({ from: minter.address, to: stranger.address, body: exp });
  });

  it('discovery includes the owner address when requested', async () => {
    const owner = randomAddress(0);
    const res = await minter.sendRequestWalletAddress(stranger.getSender(), owner, true, 100_000_000n);
    const exp = beginCell()
      .storeUint(OP_RESPONSE_WALLET_ADDRESS, 32).storeUint(0, 64)
      .storeAddress(derivedWallet(owner))
      .storeMaybeRef(beginCell().storeAddress(owner).endCell())
      .endCell();
    expect(res.transactions).toHaveTransaction({ from: minter.address, to: stranger.address, body: exp });
  });

  it('discovery with insufficient value reverts (75)', async () => {
    const res = await minter.sendRequestWalletAddress(stranger.getSender(), randomAddress(0), false, 5_000_000n);
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false, exitCode: ERR_NOT_ENOUGH_AMOUNT_TO_RESPOND });
  });

  it('get_wallet_address matches off-chain derivation', async () => {
    const owner = randomAddress(0);
    expect((await minter.getWalletAddress(owner)).equals(derivedWallet(owner))).toBe(true);
  });

  it('bounced mint rolls back supply', async () => {
    await minter.sendMint(admin.getSender(), randomAddress(0), 1000n);
    expect(await minter.getSupply()).toBe(1000n);
    const bounced = beginCell()
      .storeUint(0xffffffff, 32)
      .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(1000n).storeAddress(null)
      .endCell();
    await bc.sendMessage(internal({ from: randomAddress(0), to: minter.address, value: 50_000_000n, bounced: true, body: bounced }));
    expect(await minter.getSupply()).toBe(0n);
  });

  it('unknown opcode reverts', async () => {
    const res = await bc.sendMessage(internal({
      from: admin.address, to: minter.address, value: 50_000_000n,
      body: beginCell().storeUint(0xdeadbeef, 32).endCell(),
    }));
    expect(res.transactions).toHaveTransaction({ to: minter.address, success: false });
  });
});