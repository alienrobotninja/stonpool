import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_COMMIT = 0x10000011;
const OP_REVEAL = 0x10000012;
const OP_RUN_DRAW = 0x10000013;
const OP_DRAW_RESULT = 0x10000014;
const OP_SELECT_WINNERS = 0x10000021;
const OP_WINNERS_RESULT = 0x10000022;

const cellArg = (c: Cell) => ({ type: 'cell' as const, cell: c });

class Tester implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender, value: bigint) {
    await p.internal(via, { value, body: beginCell().endCell() });
  }
  async getCell(p: ContractProvider, name: string, stack: any[] = []): Promise<Cell> {
    return (await p.get(name, stack as any)).stack.readCell();
  }
  async getStack(p: ContractProvider, name: string, stack: any[] = []) {
    return (await p.get(name, stack as any)).stack;
  }
}

describe('C2/C3 message + struct TL-B', () => {
  let bc: Blockchain;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = loadCode('draw_selection_tester');
    const init = { code, data: beginCell().endCell() };
    bc = await Blockchain.create();
    const deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(contractAddress(0, init), init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  });

  it('LedgerEntry round-trips', async () => {
    const got = await tester.getCell('packLedgerEntry');
    expect(got).toEqualCell(beginCell().storeCoins(5000).storeUint(4, 32).endCell());
    const s = await tester.getStack('unpackLedgerEntry', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(5000n);
    expect(s.readBigNumber()).toBe(4n);
  });

  it('SelectWinners round-trips', async () => {
    const got = await tester.getCell('packSelectWinners');
    expect(got).toEqualCell(beginCell().storeUint(OP_SELECT_WINNERS, 32).storeUint(9, 64).storeUint(0xabcdefn, 256).storeUint(3, 16).endCell());
    const s = await tester.getStack('unpackSelectWinners', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(9n);
    expect(s.readBigNumber()).toBe(0xabcdefn);
    expect(s.readBigNumber()).toBe(3n);
  });

  it('WinnersResult round-trips', async () => {
    const got = await tester.getCell('packWinnersResult');
    expect(got).toEqualCell(beginCell().storeUint(OP_WINNERS_RESULT, 32).storeUint(9, 64).storeUint(7, 32).storeUint(0xabcdefn, 256).storeUint(3, 16).endCell());
    const s = await tester.getStack('unpackWinnersResult', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(9n);
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readBigNumber()).toBe(0xabcdefn);
    expect(s.readBigNumber()).toBe(3n);
  });


  it('StartDraw round-trips', async () => {
    const got = await tester.getCell('packStartDraw');
    expect(got).toEqualCell(beginCell().storeUint(OP_RUN_DRAW, 32).storeUint(1, 64).storeUint(7, 32).endCell());
    const st = await tester.getStack('unpackStartDraw', [cellArg(got)]);
    expect(st.readBigNumber()).toBe(1n);
    expect(st.readBigNumber()).toBe(7n);
  });

  it('Commit round-trips', async () => {
    const got = await tester.getCell('packCommit');
    expect(got).toEqualCell(beginCell().storeUint(OP_COMMIT, 32).storeUint(1, 64).storeUint(0x1111n, 256).endCell());
    const s = await tester.getStack('unpackCommit', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(1n);
    expect(s.readBigNumber()).toBe(0x1111n);
  });

  it('Reveal round-trips', async () => {
    const got = await tester.getCell('packReveal');
    expect(got).toEqualCell(beginCell().storeUint(OP_REVEAL, 32).storeUint(1, 64).storeUint(0x2222n, 256).endCell());
    const s = await tester.getStack('unpackReveal', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(1n);
    expect(s.readBigNumber()).toBe(0x2222n);
  });

  it('DrawResultMsg round-trips with nested DrawResult inline', async () => {
    const got = await tester.getCell('packDrawResultMsg');
    expect(got).toEqualCell(beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(1, 64).storeUint(7, 32).storeUint(123456789n, 256).endCell());
    const s = await tester.getStack('unpackDrawResultMsg', [cellArg(got)]);
    expect(s.readBigNumber()).toBe(1n);
    expect(s.readBigNumber()).toBe(7n);
    expect(s.readBigNumber()).toBe(123456789n);
  });

  it('rejects a wrong opcode prefix on a prefixed struct', async () => {
    const bad = beginCell().storeUint(0xdeadbeef, 32).storeUint(1, 64).storeUint(0, 256).endCell();
    await expect(tester.getStack('unpackCommit', [cellArg(bad)])).rejects.toThrow();
  });
});