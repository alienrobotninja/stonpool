import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { loadCode } from './helpers';

const OP_RUN_DRAW = 0x10000013;
const OP_COMMIT = 0x10000011;
const ERR_UNAUTHORIZED = 401;
const ERR_NOT_COMMIT_WINDOW = 430;
const ERR_INSUFFICIENT_BOND = 434;
const ERR_ALREADY_COMMITTED = 435;

const T0 = 1_000_000;
const COMMIT_WINDOW = 300;
const REVEAL_WINDOW = 300;
const BOND = 1_000_000_000n; // 1 TON

const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class Draw implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() });
  }
  async sendStart(p: ContractProvider, via: Sender, epoch: number) {
    await p.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_RUN_DRAW, 32).storeUint(0, 64).storeUint(epoch, 32).endCell(),
    });
  }
  async sendCommit(p: ContractProvider, via: Sender, commitHash: bigint, value: bigint) {
    await p.internal(via, {
      value,
      body: beginCell().storeUint(OP_COMMIT, 32).storeUint(0, 64).storeUint(commitHash, 256).endCell(),
    });
  }
  async getDrawState(p: ContractProvider) {
    const st = (await p.get('get_draw_state', [])).stack;
    return {
      epoch: st.readBigNumber(),
      commitDeadline: st.readBigNumber(),
      revealDeadline: st.readBigNumber(),
      finalized: st.readBoolean(),
      seed: st.readBigNumber(),
    };
  }
  async getCommit(p: ContractProvider, who: Address) {
    const st = (await p.get('get_commit', [addrArg(who)])).stack;
    return { commitHash: st.readBigNumber(), bond: st.readBigNumber(), revealed: st.readBoolean() };
  }
}

function drawData(poolCore: Address): Cell {
  return beginCell()
    .storeAddress(poolCore)
    .storeUint(0, 32)            // epoch
    .storeUint(COMMIT_WINDOW, 32)
    .storeUint(REVEAL_WINDOW, 32)
    .storeCoins(BOND)
    .storeUint(0, 32)            // commitDeadline
    .storeUint(0, 32)            // revealDeadline
    .storeBit(false)            // finalized
    .storeUint(0, 256)          // seed
    .storeBit(false)            // empty commits map
    .endCell();
}

describe('C3 draw-engine commit phase', () => {
  let bc: Blockchain;
  let code: Cell;
  let poolCore: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;

  beforeAll(() => { code = loadCode('draw_engine'); });

  async function fresh(): Promise<SandboxContract<Draw>> {
    bc = await Blockchain.create();
    bc.now = T0;
    poolCore = await bc.treasury('poolCore');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');
    const init = { code, data: drawData(poolCore.address) };
    const d = bc.openContract(new Draw(contractAddress(0, init), init));
    await d.sendDeploy(poolCore.getSender());
    return d;
  }

  // start a draw, used by most commit tests
  async function started(): Promise<SandboxContract<Draw>> {
    const d = await fresh();
    await d.sendStart(poolCore.getSender(), 7);
    return d;
  }

  it('start sets the commit/reveal deadlines off the configured windows', async () => {
    const d = await started();
    const s = await d.getDrawState();
    expect(s.epoch).toBe(7n);
    expect(s.commitDeadline).toBe(BigInt(T0 + COMMIT_WINDOW));
    expect(s.revealDeadline).toBe(BigInt(T0 + COMMIT_WINDOW + REVEAL_WINDOW));
    expect(s.finalized).toBe(false);
    expect(s.seed).toBe(0n);
  });

  it('only poolCore can start a draw', async () => {
    const d = await fresh();
    const r = await d.sendStart(stranger.getSender(), 7);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await d.getDrawState()).commitDeadline).toBe(0n);
  });

  it('records a commit inside the window with sufficient bond', async () => {
    const d = await started();
    const h = 0xdeadbeefn;
    await d.sendCommit(alice.getSender(), h, BOND);
    const c = await d.getCommit(alice.address);
    expect(c.commitHash).toBe(h);
    expect(c.bond).toBe(BOND);
    expect(c.revealed).toBe(false);
  });

  it('rejects a commit before the draw is started', async () => {
    const d = await fresh(); // never started -> commitDeadline 0
    const r = await d.sendCommit(alice.getSender(), 1n, BOND);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_NOT_COMMIT_WINDOW });
  });

  it('rejects a commit after the commit deadline', async () => {
    const d = await started();
    bc.now = T0 + COMMIT_WINDOW + 1;
    const r = await d.sendCommit(alice.getSender(), 1n, BOND);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_NOT_COMMIT_WINDOW });
  });

  it('rejects an underbonded commit', async () => {
    const d = await started();
    const r = await d.sendCommit(alice.getSender(), 1n, BOND - 1n);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_INSUFFICIENT_BOND });
    expect((await d.getCommit(alice.address)).bond).toBe(0n);
  });

  it('rejects a double commit from the same address', async () => {
    const d = await started();
    await d.sendCommit(alice.getSender(), 0x1n, BOND);
    const r = await d.sendCommit(alice.getSender(), 0x2n, BOND);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_ALREADY_COMMITTED });
    expect((await d.getCommit(alice.address)).commitHash).toBe(0x1n); // unchanged
  });

  it('escrows each committer bond independently', async () => {
    const d = await started();
    await d.sendCommit(alice.getSender(), 0xa1n, BOND);
    await d.sendCommit(bob.getSender(), 0xb2n, BOND + 5_000_000n);
    expect((await d.getCommit(alice.address)).bond).toBe(BOND);
    expect((await d.getCommit(bob.address)).bond).toBe(BOND + 5_000_000n);
  });
});