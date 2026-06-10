import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

// Mirrors the literal opcodes/layout in mock_stonfi_messages.tolk.
const OP_PROVIDE_LP = 0x37c096df;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_MINT = 0x00000015;

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

describe('mock STON.fi message layouts (S1)', () => {
  let bc: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = loadCode('mock_stonfi_tester');
    const init = { code, data: beginCell().endCell() };
    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(contractAddress(0, init), init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  }, 30000);

  const addrSlice = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

  it('ProvideLpForward: op + minLpOut + toAddress + bothPositive', async () => {
    const to = deployer.address;
    const got = await tester.getCell('packProvideLpForward', [addrSlice(to)]);
    const exp = beginCell().storeUint(OP_PROVIDE_LP, 32).storeCoins(7).storeAddress(to).storeBit(false).endCell();
    expect(got).toEqualCell(exp);
  });

  it('ProvideLpForward round-trips through unpack', async () => {
    const to = deployer.address;
    const packed = await tester.getCell('packProvideLpForward', [addrSlice(to)]);
    const s = await tester.getStack('unpackProvideLpForward', [{ type: 'cell' as const, cell: packed }]);
    expect(s.readBigNumber()).toBe(BigInt(OP_PROVIDE_LP));
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readAddress().equals(to)).toBe(true);
    expect(s.readBoolean()).toBe(false);
  });

  it('ProvideLp: op + queryId + amount + to + minLpOut + bothPositive', async () => {
    const to = deployer.address;
    const got = await tester.getCell('packProvideLp', [addrSlice(to)]);
    const exp = beginCell()
      .storeUint(OP_PROVIDE_LP, 32).storeUint(42, 64).storeCoins(1000).storeAddress(to).storeCoins(7).storeBit(false)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('ProvideLp round-trips through unpack', async () => {
    const to = deployer.address;
    const packed = await tester.getCell('packProvideLp', [addrSlice(to)]);
    const s = await tester.getStack('unpackProvideLp', [{ type: 'cell' as const, cell: packed }]);
    expect(s.readBigNumber()).toBe(42n);
    expect(s.readBigNumber()).toBe(1000n);
    expect(s.readAddress().equals(to)).toBe(true);
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readBoolean()).toBe(false);
  });

  it('LpMintInternal is byte-compatible with the jetton internal_transfer wire', async () => {
    const got = await tester.getCell('packLpMintInternal');
    const exp = beginCell()
      .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(42, 64).storeCoins(9)
      .storeAddress(null).storeAddress(null).storeCoins(0)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('MintLp is byte-compatible with the jetton minter mint wire', async () => {
    const to = deployer.address;
    const innerExp = beginCell()
      .storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(42, 64).storeCoins(9)
      .storeAddress(null).storeAddress(null).storeCoins(0)
      .endCell();
    const got = await tester.getCell('packMintLp', [addrSlice(to)]);
    const exp = beginCell()
      .storeUint(OP_MINT, 32).storeUint(42, 64).storeAddress(to).storeCoins(100_000_000n).storeRef(innerExp)
      .endCell();
    expect(got).toEqualCell(exp);
  });
});