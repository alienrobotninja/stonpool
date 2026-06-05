import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Opcodes from shared.tolk, duplicated here as the off-chain expectation.
// If these drift from shared.tolk, the parity assertions below fail, which is
// exactly the guard we want on the frozen wire format.
const OP_HARVEST_YIELD = 0x10000033;
const OP_DEPOSIT = 0x10000001;


class Tester implements Contract {
  constructor(
    readonly address: Address,
    readonly init: { code: Cell; data: Cell },
  ) {}

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async getCell(provider: ContractProvider, name: string, stack: any[] = []): Promise<Cell> {
    const r = await provider.get(name, stack as any);
    return r.stack.readCell();
  }

  async getStack(provider: ContractProvider, name: string, stack: any[] = []) {
    return (await provider.get(name, stack as any)).stack;
  }
}

describe('C0 shared TL-B layouts', () => {
  let bc: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = loadCode('shared_tester');
    const init = { code, data: beginCell().endCell() };
    const address = contractAddress(0, init);

    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(address, init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  }, 30000);

  it('PoolConfig packs fields in declaration order', async () => {
    const got = await tester.getCell('packPoolConfig');
    const exp = beginCell()
      .storeUint(86400, 32)
      .storeUint(3600, 32)
      .storeUint(300, 32)
      .storeUint(300, 32)
      .storeUint(1, 16)
      .storeUint(3, 8)
      .storeUint(1500, 16)
      .storeCoins(1_000_000_000)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('DrawResult packs epoch + 256-bit seed', async () => {
    const got = await tester.getCell('packDrawResult');
    const exp = beginCell().storeUint(7, 32).storeUint(123456789, 256).endCell();
    expect(got).toEqualCell(exp);
  });

  it('AdapterReport packs coins as varuint and bool as one bit', async () => {
    const got = await tester.getCell('packAdapterReport');
    const exp = beginCell()
      .storeUint(OP_HARVEST_YIELD, 32)
      .storeCoins(5)
      .storeCoins(2)
      .storeBit(true)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('DepositPayload packs op + address', async () => {
    const addr = deployer.address;
    const got = await tester.getCell('packDepositPayload', [
      { type: 'slice', cell: beginCell().storeAddress(addr).endCell() },
    ]);
    const exp = beginCell().storeUint(OP_DEPOSIT, 32).storeAddress(addr).endCell();
    expect(got).toEqualCell(exp);
  });

  const cellArg = (c: Cell) => ({ type: 'cell' as const, cell: c });

  it('PoolConfig deserializes back to its fields', async () => {
    const cell = beginCell()
      .storeUint(86400, 32).storeUint(3600, 32).storeUint(300, 32).storeUint(300, 32)
      .storeUint(1, 16).storeUint(3, 8).storeUint(1500, 16).storeCoins(1_000_000_000)
      .endCell();
    const s = await tester.getStack('unpackPoolConfig', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(86400n);
    expect(s.readBigNumber()).toBe(3600n);
    expect(s.readBigNumber()).toBe(300n);
    expect(s.readBigNumber()).toBe(300n);
    expect(s.readBigNumber()).toBe(1n);
    expect(s.readBigNumber()).toBe(3n);
    expect(s.readBigNumber()).toBe(1500n);
    expect(s.readBigNumber()).toBe(1_000_000_000n);
  });

  it('DrawResult deserializes back to its fields', async () => {
    const cell = beginCell().storeUint(7, 32).storeUint(123456789, 256).endCell();
    const s = await tester.getStack('unpackDrawResult', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readBigNumber()).toBe(123456789n);
  });

  it('AdapterReport deserializes back to its fields', async () => {
    const cell = beginCell().storeUint(0x10000033, 32).storeCoins(5).storeCoins(2).storeBit(true).endCell();
    const s = await tester.getStack('unpackAdapterReport', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(0x10000033n);
    expect(s.readBigNumber()).toBe(5n);
    expect(s.readBigNumber()).toBe(2n);
    expect(s.readBoolean()).toBe(true);
  });

  it('DepositPayload deserializes back to its fields', async () => {
    const addr = deployer.address;
    const cell = beginCell().storeUint(0x10000001, 32).storeAddress(addr).endCell();
    const s = await tester.getStack('unpackDepositPayload', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(0x10000001n);
    expect(s.readAddress().equals(addr)).toBe(true);
  });

  it('rejects trailing data on strict decode', async () => {
    const bad = beginCell().storeUint(7, 32).storeUint(123456789, 256).storeUint(0xff, 8).endCell();
    await expect(tester.getStack('unpackDrawResult', [cellArg(bad)])).rejects.toThrow();
  });
});