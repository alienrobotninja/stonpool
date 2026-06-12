import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { loadCode } from './helpers';

const OP_RUN_DRAW = 0x10000013;
const OP_COMMIT = 0x10000011;
const OP_REVEAL = 0x10000012;
const OP_FINALIZE = 0x10000015;
const OP_DRAW_RESULT = 0x10000014;
const ERR_UNAUTHORIZED = 401;
const ERR_NOT_COMMIT_WINDOW = 430;
const ERR_INSUFFICIENT_BOND = 434;
const ERR_ALREADY_COMMITTED = 435;
const ERR_ALREADY_REVEALED = 436;
const ERR_NOT_REVEAL_WINDOW = 431;
const ERR_NO_COMMIT = 432;
const ERR_BAD_REVEAL = 433;
const ERR_EPOCH_NOT_ENDED = 420;
const ERR_EPOCH_ALREADY_DRAWN = 421;
const ERR_INVALID_PARAMS = 441;
const ERR_BUSY = 451;

const T0 = 1_000_000;
const COMMIT_WINDOW = 300;
const REVEAL_WINDOW = 300;
const BOND = 1_000_000_000n; // 1 TON
const DRAW_RESULT_GAS = 500_000_000n; // 0.5 TON gas allowance carried on DrawResult

const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

const h256 = (c: Cell): bigint => BigInt('0x' + c.hash().toString('hex'));
const commitHashOf = (secret: bigint) => h256(beginCell().storeUint(secret, 256).endCell());
const mixSeed = (seed: bigint, secret: bigint) => h256(beginCell().storeUint(seed, 256).storeUint(secret, 256).endCell());

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
  async sendReveal(p: ContractProvider, via: Sender, secret: bigint, value: bigint = 100_000_000n) {
    await p.internal(via, {
      value,
      body: beginCell().storeUint(OP_REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell(),
    });
  }
  async sendFinalize(p: ContractProvider, via: Sender, value: bigint = 200_000_000n) {
    await p.internal(via, {
      value,
      body: beginCell().storeUint(OP_FINALIZE, 32).storeUint(0, 64).endCell(),
    });
  }
  async getPhase(p: ContractProvider): Promise<bigint> {
    return (await p.get('get_phase', [])).stack.readBigNumber();
  }
  async getTallies(p: ContractProvider) {
    const st = (await p.get('get_tallies', [])).stack;
    return { total: st.readBigNumber(), revealed: st.readBigNumber() };
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

function drawData(poolCore: Address, commitWindow = COMMIT_WINDOW, revealWindow = REVEAL_WINDOW): Cell {
  return beginCell()
    .storeAddress(poolCore)
    .storeUint(0, 32)            // epoch
    .storeUint(commitWindow, 32)
    .storeUint(revealWindow, 32)
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
  let carol: SandboxContract<TreasuryContract>;

  beforeAll(() => { code = loadCode('draw_engine'); });

  async function fresh(): Promise<SandboxContract<Draw>> {
    bc = await Blockchain.create();
    bc.now = T0;
    poolCore = await bc.treasury('poolCore');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');
    carol = await bc.treasury('carol');
    const init = { code, data: drawData(poolCore.address) };
    const d = bc.openContract(new Draw(contractAddress(0, init), init));
    await d.sendDeploy(poolCore.getSender());
    return d;
  }

  async function freshWith(commitWindow: number, revealWindow: number): Promise<SandboxContract<Draw>> {
    bc = await Blockchain.create();
    bc.now = T0;
    poolCore = await bc.treasury('poolCore');
    const init = { code, data: drawData(poolCore.address, commitWindow, revealWindow) };
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

  // commit alice (and optionally bob) inside the window with known secrets
  const SA = 0x5ec5e741n;
  const SB = 0xb0bb0b0bn;
  async function committed(): Promise<SandboxContract<Draw>> {
    const d = await started();
    await d.sendCommit(alice.getSender(), commitHashOf(SA), BOND);
    await d.sendCommit(bob.getSender(), commitHashOf(SB), BOND);
    return d;
  }

  it('reveal in window verifies the hash, marks revealed, folds the seed', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW; // enter reveal window
    await d.sendReveal(alice.getSender(), SA);
    const c = await d.getCommit(alice.address);
    expect(c.revealed).toBe(true);
    expect((await d.getDrawState()).seed).toBe(mixSeed(0n, SA));
  });

  it('seed mixing is order-dependent and reproducible off-chain', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    await d.sendReveal(alice.getSender(), SA);
    await d.sendReveal(bob.getSender(), SB);
    expect((await d.getDrawState()).seed).toBe(mixSeed(mixSeed(0n, SA), SB));
  });

  it('reveal refunds the bond to the committer', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    const r = await d.sendReveal(alice.getSender(), SA);
    expect(r.transactions).toHaveTransaction({ from: d.address, to: alice.address, value: BOND });
  });

  it('rejects a reveal during the commit window (too early)', async () => {
    const d = await committed(); // bc.now still T0 (commit window)
    const r = await d.sendReveal(alice.getSender(), SA);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_NOT_REVEAL_WINDOW });
  });

  it('rejects a reveal after the reveal deadline (too late)', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW; // == revealDeadline, window is half-open
    const r = await d.sendReveal(alice.getSender(), SA);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_NOT_REVEAL_WINDOW });
  });

  it('rejects a reveal with no prior commit', async () => {
    const d = await started();
    bc.now = T0 + COMMIT_WINDOW;
    const r = await d.sendReveal(stranger.getSender(), 0x1n);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_NO_COMMIT });
  });

  it('rejects a secret that does not match the commit hash', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    const r = await d.sendReveal(alice.getSender(), SA + 1n); // wrong secret
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_BAD_REVEAL });
    expect((await d.getCommit(alice.address)).revealed).toBe(false);
  });

  it('rejects a double reveal', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    await d.sendReveal(alice.getSender(), SA);
    const r = await d.sendReveal(alice.getSender(), SA);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_ALREADY_REVEALED });
  });


  // start + commit alice & bob; reveal the listed secrets, then jump past revealDeadline
  async function readyToFinalize(reveal: { a?: boolean; b?: boolean }): Promise<SandboxContract<Draw>> {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW; // reveal window
    if (reveal.a) await d.sendReveal(alice.getSender(), SA);
    if (reveal.b) await d.sendReveal(bob.getSender(), SB);
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW; // revealDeadline reached
    return d;
  }

  it('finalize after full reveal emits DrawResult with the pure reveal-fold seed, nothing slashed', async () => {
    const d = await readyToFinalize({ a: true, b: true });
    const r = await d.sendFinalize(poolCore.getSender());
    const expected = mixSeed(mixSeed(0n, SA), SB);
    expect((await d.getDrawState()).finalized).toBe(true);
    expect((await d.getDrawState()).seed).toBe(expected);
    expect(await d.getPhase()).toBe(4n);
    expect(r.transactions).toHaveTransaction({ from: d.address, to: poolCore.address, op: OP_DRAW_RESULT, value: DRAW_RESULT_GAS });
  });

  it('finalize slashes a no-show bond into the pot forwarded to poolCore', async () => {
    const d = await readyToFinalize({ a: true, b: false }); // bob never reveals
    const r = await d.sendFinalize(poolCore.getSender());
    expect((await d.getDrawState()).seed).toBe(mixSeed(0n, SA)); // only alice's secret
    expect(r.transactions).toHaveTransaction({ from: d.address, to: poolCore.address, op: OP_DRAW_RESULT, value: BOND + DRAW_RESULT_GAS });
  });

  it('fallback: zero reveals seeds from chain entropy and slashes every bond', async () => {
    const d = await readyToFinalize({}); // nobody reveals
    const r = await d.sendFinalize(poolCore.getSender());
    expect((await d.getDrawState()).seed).not.toBe(0n); // entropy injected
    expect((await d.getDrawState()).finalized).toBe(true);
    expect(r.transactions).toHaveTransaction({ from: d.address, to: poolCore.address, op: OP_DRAW_RESULT, value: 2n * BOND + DRAW_RESULT_GAS });
  });

  it('rejects finalize before the reveal deadline', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW; // reveal window still open
    const r = await d.sendFinalize(poolCore.getSender());
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_EPOCH_NOT_ENDED });
  });

  it('only poolCore can finalize', async () => {
    const d = await readyToFinalize({ a: true, b: true });
    const r = await d.sendFinalize(stranger.getSender());
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('rejects a double finalize', async () => {
    const d = await readyToFinalize({ a: true, b: true });
    await d.sendFinalize(poolCore.getSender());
    const r = await d.sendFinalize(poolCore.getSender());
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_EPOCH_ALREADY_DRAWN });
  });

  it('get_phase walks idle -> commit -> reveal -> awaiting -> finalized', async () => {
    const d = await fresh();
    expect(await d.getPhase()).toBe(0n);                 // idle
    await d.sendStart(poolCore.getSender(), 7);
    expect(await d.getPhase()).toBe(1n);                 // commit
    bc.now = T0 + COMMIT_WINDOW;
    expect(await d.getPhase()).toBe(2n);                 // reveal
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW;
    expect(await d.getPhase()).toBe(3n);                 // awaiting finalize
    await d.sendFinalize(poolCore.getSender());
    expect(await d.getPhase()).toBe(4n);                 // finalized
  });

  it('get_tallies reports commit and reveal counts', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    await d.sendReveal(alice.getSender(), SA);
    const t = await d.getTallies();
    expect(t.total).toBe(2n);
    expect(t.revealed).toBe(1n);
  });


  it('rejects StartDraw while a draw is live (mid-commit), leaving it intact', async () => {
    const d = await started();
    await d.sendCommit(alice.getSender(), 0xa1n, BOND);
    const before = await d.getDrawState();
    const r = await d.sendStart(poolCore.getSender(), 8);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_BUSY });
    expect((await d.getDrawState()).commitDeadline).toBe(before.commitDeadline); // unchanged
    expect((await d.getCommit(alice.address)).bond).toBe(BOND);                  // commit not wiped
  });

  it('rejects StartDraw mid-reveal', async () => {
    const d = await started();
    await d.sendCommit(alice.getSender(), commitHashOf(SA), BOND);
    bc.now = T0 + COMMIT_WINDOW;
    const r = await d.sendStart(poolCore.getSender(), 8);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_BUSY });
  });

  it('allows StartDraw again once the previous draw is finalized, clearing old state', async () => {
    const d = await readyToFinalize({ a: true, b: true });
    await d.sendFinalize(poolCore.getSender());
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW + 10;
    const r = await d.sendStart(poolCore.getSender(), 8);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: true });
    const st = await d.getDrawState();
    expect(st.epoch).toBe(8n);
    expect(st.finalized).toBe(false);
    expect(st.seed).toBe(0n);
    expect(await d.getPhase()).toBe(1n);                       // back to commit
    expect((await d.getTallies()).total).toBe(0n);            // old commits cleared
    expect((await d.getCommit(alice.address)).bond).toBe(0n);
  });

  it('rejects StartDraw when configured with a zero window', async () => {
    const d = await freshWith(0, REVEAL_WINDOW);
    const r = await d.sendStart(poolCore.getSender(), 7);
    expect(r.transactions).toHaveTransaction({ to: d.address, success: false, exitCode: ERR_INVALID_PARAMS });
  });

  it('accounts every bond: revealers refunded, no-shows slashed to poolCore', async () => {
    const d = await started();
    await d.sendCommit(alice.getSender(), commitHashOf(SA), BOND);
    await d.sendCommit(bob.getSender(), 0xb2n, BOND);     // bob no-show
    await d.sendCommit(carol.getSender(), 0xc3n, BOND);   // carol no-show
    bc.now = T0 + COMMIT_WINDOW;
    const refund = await d.sendReveal(alice.getSender(), SA);
    expect(refund.transactions).toHaveTransaction({ from: d.address, to: alice.address, value: BOND });
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW;
    const fin = await d.sendFinalize(poolCore.getSender());
    // 3 bonds in: 1 refunded + 2 slashed -> poolCore receives exactly 2*BOND
    expect(fin.transactions).toHaveTransaction({ from: d.address, to: poolCore.address, op: OP_DRAW_RESULT, value: 2n * BOND + DRAW_RESULT_GAS });
  });

  it('a failed reveal (bad secret) refunds nothing (checks before effects)', async () => {
    const d = await committed();
    bc.now = T0 + COMMIT_WINDOW;
    const r = await d.sendReveal(alice.getSender(), SA + 1n);
    expect(r.transactions).not.toHaveTransaction({ from: d.address, to: alice.address, value: BOND });
    expect((await d.getCommit(alice.address)).revealed).toBe(false);
  });

});