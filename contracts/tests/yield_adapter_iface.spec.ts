import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Mirrors the literal opcodes in yield_adapter_iface.tolk / shared.tolk.
const OP_DEPOSIT_PRINCIPAL = 0x10000031;
const OP_WITHDRAW_PRINCIPAL = 0x10000032;
const OP_HARVEST_YIELD = 0x10000033;
const OP_ADAPTER_REPORT = 0x10000034;

const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');

async function compile(entry: string): Promise<Cell> {
  const res = await runTolkCompiler({
    entrypointFileName: entry,
    fsReadCallback: (p) => readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
  });
  if (res.status !== 'ok') throw new Error(res.message);
  return Cell.fromBase64(res.codeBoc64);
}

class Tester implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
  async getCell(provider: ContractProvider, name: string, stack: any[] = []): Promise<Cell> {
    return (await provider.get(name, stack as any)).stack.readCell();
  }

  async getStack(provider: ContractProvider, name: string, stack: any[] = []) {
    return (await provider.get(name, stack as any)).stack;
  }
}

describe('C5 yield-adapter-iface message layouts', () => {
  let bc: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = await compile('iface_tester.tolk');
    const init = { code, data: beginCell().endCell() };
    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(contractAddress(0, init), init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  }, 30000);

  const addrSlice = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

  it('DepositPrincipal: op + queryId', async () => {
    const got = await tester.getCell('packDepositPrincipal');
    const exp = beginCell().storeUint(OP_DEPOSIT_PRINCIPAL, 32).storeUint(42, 64).endCell();
    expect(got).toEqualCell(exp);
  });

  it('WithdrawPrincipal: op + queryId + amount + to', async () => {
    const to = deployer.address;
    const got = await tester.getCell('packWithdrawPrincipal', [addrSlice(to)]);
    const exp = beginCell()
      .storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeUint(42, 64).storeCoins(7).storeAddress(to)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('HarvestYield: op + queryId + to', async () => {
    const to = deployer.address;
    const got = await tester.getCell('packHarvestYield', [addrSlice(to)]);
    const exp = beginCell().storeUint(OP_HARVEST_YIELD, 32).storeUint(42, 64).storeAddress(to).endCell();
    expect(got).toEqualCell(exp);
  });

  it('AdapterReportMsg: op + queryId + inline AdapterReport', async () => {
    const got = await tester.getCell('packAdapterReportMsg');
    const exp = beginCell()
      .storeUint(OP_ADAPTER_REPORT, 32).storeUint(42, 64)
      .storeUint(OP_HARVEST_YIELD, 32).storeCoins(5).storeCoins(2).storeBit(true)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  const cellArg = (c: Cell) => ({ type: 'cell' as const, cell: c });

  it('DepositPrincipal deserializes back to its fields', async () => {
    const cell = beginCell().storeUint(OP_DEPOSIT_PRINCIPAL, 32).storeUint(42, 64).endCell();
    const s = await tester.getStack('unpackDepositPrincipal', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(42n);
  });

  it('WithdrawPrincipal deserializes back to its fields', async () => {
    const to = deployer.address;
    const cell = beginCell()
      .storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeUint(42, 64).storeCoins(7).storeAddress(to)
      .endCell();
    const s = await tester.getStack('unpackWithdrawPrincipal', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(42n);
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readAddress().equals(to)).toBe(true);
  });

  it('HarvestYield deserializes back to its fields', async () => {
    const to = deployer.address;
    const cell = beginCell().storeUint(OP_HARVEST_YIELD, 32).storeUint(42, 64).storeAddress(to).endCell();
    const s = await tester.getStack('unpackHarvestYield', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(42n);
    expect(s.readAddress().equals(to)).toBe(true);
  });

  it('AdapterReportMsg deserializes back, including the nested report', async () => {
    const cell = beginCell()
      .storeUint(OP_ADAPTER_REPORT, 32).storeUint(42, 64)
      .storeUint(OP_HARVEST_YIELD, 32).storeCoins(5).storeCoins(2).storeBit(true)
      .endCell();
    const s = await tester.getStack('unpackAdapterReportMsg', [cellArg(cell)]);
    expect(s.readBigNumber()).toBe(42n);
    expect(s.readBigNumber()).toBe(0x10000033n);
    expect(s.readBigNumber()).toBe(5n);
    expect(s.readBigNumber()).toBe(2n);
    expect(s.readBoolean()).toBe(true);
  });
});