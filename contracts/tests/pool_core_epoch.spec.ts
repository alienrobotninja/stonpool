import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { PoolConfig } from '../wrappers/protocol';
import { poolCoreData } from '../wrappers/PoolCore';

const OP_ADVANCE_EPOCH = 0x10000004;
const OP_HARVEST_YIELD = 0x10000033;
const OP_RUN_DRAW = 0x10000013;
const OP_DRAW_RESULT = 0x10000014;
const OP_CLEAR_DRAW_OPEN = 0x10000017;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_UNAUTHORIZED = 401;
const ERR_EPOCH_NOT_ENDED = 420;
const ERR_BUSY = 451;

const ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3;

const T0 = 1_000_000;
const EPOCH = 5;
const EPOCH_LENGTH = 3600;
const DEPOSIT_CUTOFF = 600;

const CFG: PoolConfig = { epochLength: EPOCH_LENGTH, depositCutoff: DEPOSIT_CUTOFF, commitWindow: 900, revealWindow: 900, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
  }
  async sendClearDrawOpen(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CLEAR_DRAW_OPEN, 32).storeUint(0, 64).endCell() });
  }
  async sendAdvance(p: ContractProvider, via: Sender, value = 600_000_000n) {
    await p.internal(via, { value, body: beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell() });
  }
  async getData(p: ContractProvider) {
    const s = (await p.get('get_pool_data', [])).stack;
    return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() };
  }
  // true while a draw opened by AdvanceEpoch has not yet reported back
  async getDrawOpen(p: ContractProvider): Promise<boolean> {
    return (await p.get('get_draw_open', [])).stack.readBoolean();
  }
}

describe('C1 pool-core epoch lifecycle', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<TreasuryContract>;
  let drawEngine: SandboxContract<TreasuryContract>;
  let vault: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  function poolData(): Cell {
    return poolCoreData({ epoch: EPOCH, genesis: T0, admin: admin.address, config: CFG });
  }

  async function fresh(): Promise<SandboxContract<Pool>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    adapter = await bc.treasury('adapter');
    drawEngine = await bc.treasury('drawEngine');
    vault = await bc.treasury('vault');
    stranger = await bc.treasury('stranger');
    const init = { code, data: poolData() };
    const p = bc.openContract(new Pool(contractAddress(0, init), init));
    await p.sendDeploy(admin.getSender());
    await p.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    await p.sendConfigure(admin.getSender(), ROLE_DRAW_ENGINE, drawEngine.address);
    await p.sendConfigure(admin.getSender(), ROLE_VAULT, vault.address);
    return p;
  }

  // deliver a DrawResultMsg as the wired draw-engine would. This fixture has an empty
  // ledger, so pool-core takes the eligible==0 branch: the pot rolls over and no
  // payouts fire. That is exactly the path the deadlock guard below cares about.
  async function deliverDraw(epoch: number, seed = 0xfeedn) {
    const body = beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64)
      .storeUint(epoch, 32).storeUint(seed, 256).endCell();
    return bc.sendMessage(internal({ from: drawEngine.address, to: pool.address, value: 1_500_000_000n, body }));
  }

  // Wire the pool to a REAL draw-engine rather than the treasury stub the other tests
  // use. With commitWindow = 0 its StartDraw handler throws ERR_INVALID_PARAMS for real,
  // which is the only honest way to exercise the bounce: faking it would prove nothing
  // about whether START_DRAW_GAS actually funds the bounce back.
  let engine: Address;
  async function freshWithEngine(commitWindow: number): Promise<SandboxContract<Pool>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    adapter = await bc.treasury('adapter');
    vault = await bc.treasury('vault');
    stranger = await bc.treasury('stranger');

    const pInit = { code, data: poolData() };
    const poolAddr = contractAddress(0, pInit);

    // DrawStorage: poolCore, epoch, commitWindow, revealWindow, drawBond,
    // commitDeadline, revealDeadline, finalized, seed, commits
    const dInit = { code: loadCode('draw_engine'), data: beginCell()
      .storeAddress(poolAddr)
      .storeUint(0, 32)
      .storeUint(commitWindow, 32)
      .storeUint(900, 32)
      .storeCoins(1_000_000_000n)
      .storeUint(0, 32).storeUint(0, 32)
      .storeBit(false)
      .storeUint(0, 256)
      .storeBit(false)
      .endCell() };
    engine = contractAddress(0, dInit);
    await bc.sendMessage(internal({ from: admin.address, to: engine, value: toNano('1'), body: beginCell().endCell(), stateInit: dInit }));

    const p = bc.openContract(new Pool(poolAddr, pInit));
    await p.sendDeploy(admin.getSender());
    await p.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    await p.sendConfigure(admin.getSender(), ROLE_DRAW_ENGINE, engine);
    await p.sendConfigure(admin.getSender(), ROLE_VAULT, vault.address);
    return p;
  }

  it('advance rolls the epoch and recomputes the deposit deadline', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH; // epoch ended
    await pool.sendAdvance(admin.getSender());
    const d = await pool.getData();
    expect(d.epoch).toBe(BigInt(EPOCH + 1));
    expect(d.depositDeadline).toBe(BigInt(T0 + EPOCH_LENGTH + EPOCH_LENGTH - DEPOSIT_CUTOFF));
  });

  it('rejects advance before the epoch ends (420)', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH - 1;
    const r = await pool.sendAdvance(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_EPOCH_NOT_ENDED });
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH)); // unchanged
  });

  it('dispatches harvest to the adapter and starts the draw for the ended epoch', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    const r = await pool.sendAdvance(admin.getSender());
    expect(r.transactions).toHaveTransaction({ from: pool.address, to: adapter.address, op: OP_HARVEST_YIELD });
    // StartDraw carries the ENDED epoch (5), not the new one
    const startBody = beginCell().storeUint(OP_RUN_DRAW, 32).storeUint(0, 64).storeUint(EPOCH, 32).endCell();
    expect(r.transactions).toHaveTransaction({ from: pool.address, to: drawEngine.address, body: startBody });
  });

  it('only admin can advance the epoch (401)', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    const r = await pool.sendAdvance(stranger.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH));
  });

  it('drawOpen starts clear and is armed by advance', async () => {
    pool = await fresh();
    expect(await pool.getDrawOpen()).toBe(false);
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    expect(await pool.getDrawOpen()).toBe(true);
  });

  // BUG-2 regression. Advancing again while the previous draw is still outstanding
  // used to orphan it silently: draw-engine rejects the second StartDraw with
  // ERR_BUSY, but that send is NoBounce and the throw lands in a separate
  // transaction, so pool-core never heard about it and had already committed the
  // epoch bump. The epoch moved on with no draw, and the old draw was stranded.
  // The bump cannot be undone after the fact, so pool-core refuses up front.
  it('rejects a second advance while a draw is still outstanding (451)', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    expect(await pool.getDrawOpen()).toBe(true);

    bc.now = T0 + 2 * EPOCH_LENGTH; // next epoch has genuinely ended: only drawOpen blocks us
    const r = await pool.sendAdvance(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_BUSY });
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH + 1)); // NOT advanced: no orphan
    expect(await pool.getDrawOpen()).toBe(true);
  });

  // The eligible==0 branch of DrawResultMsg returns early without saving. If drawOpen
  // were cleared after that check, a draw with no eligible depositors would leave the
  // flag stuck true and every future advance would throw ERR_BUSY forever: the pool
  // would be permanently bricked. It is cleared before the branch, so this holds.
  it('draw result clears drawOpen even when no depositors are eligible', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    expect(await pool.getDrawOpen()).toBe(true);

    // empty ledger -> eligible == 0 -> the early-return path
    const r = await deliverDraw(EPOCH);
    expect(r.transactions).toHaveTransaction({ to: pool.address, from: drawEngine.address, success: true });
    expect(await pool.getDrawOpen()).toBe(false);
  });

  // BUG-2 follow-up (audit Finding B). drawOpen is armed before the StartDraw send. If
  // the draw never opens, no DrawResultMsg will ever arrive to clear it, so without a
  // bounce the flag strands true and ERR_BUSY blocks every future advance forever.
  it('a bounced StartDraw clears drawOpen and advance works again', async () => {
    pool = await freshWithEngine(0); // commitWindow = 0 -> StartDraw throws ERR_INVALID_PARAMS
    bc.now = T0 + EPOCH_LENGTH;
    const r = await pool.sendAdvance(admin.getSender());

    // the engine really did reject it...
    expect(r.transactions).toHaveTransaction({ from: pool.address, to: engine, success: false });
    // ...and the bounce really did come back. If this assertion fails, START_DRAW_GAS
    // does not fund the bounce and the automatic path is dead - report it, do not just
    // raise the constant.
    expect(r.transactions).toHaveTransaction({ from: engine, to: pool.address, inMessageBounced: true, success: true });

    expect(await pool.getDrawOpen()).toBe(false);
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH + 1)); // the bump stands
    expect((await pool.getData()).prizePot).toBe(0n);             // nothing else disturbed

    bc.now = T0 + 2 * EPOCH_LENGTH;
    const r2 = await pool.sendAdvance(admin.getSender());
    expect(r2.transactions).toHaveTransaction({ to: pool.address, success: true });
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH + 2));
  });

  // The bounce is an optimisation, not the safety net: TON guarantees nothing about
  // bounce delivery (it needs gas, and bounces cannot be re-bounced). The hatch is what
  // makes the worst case "one admin transaction" instead of "pool bricked forever".
  it('ClearDrawOpen releases the guard when the bounce never came', async () => {
    pool = await fresh(); // drawEngine is a treasury stub: StartDraw is swallowed, no bounce
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    expect(await pool.getDrawOpen()).toBe(true);

    const r = await pool.sendClearDrawOpen(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
    expect(await pool.getDrawOpen()).toBe(false);

    bc.now = T0 + 2 * EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH + 2));
  });

  it('only admin can clear the guard (401)', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    const r = await pool.sendClearDrawOpen(stranger.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect(await pool.getDrawOpen()).toBe(true); // untouched
  });

  it('clearing an already-clear guard is a no-op, not a failure', async () => {
    pool = await fresh();
    expect(await pool.getDrawOpen()).toBe(false);
    const r = await pool.sendClearDrawOpen(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
    expect(await pool.getDrawOpen()).toBe(false);
  });

  it('advance succeeds again once the draw has reported back', async () => {
    pool = await fresh();
    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender());
    await deliverDraw(EPOCH);
    expect(await pool.getDrawOpen()).toBe(false);

    bc.now = T0 + 2 * EPOCH_LENGTH;
    const r = await pool.sendAdvance(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
    expect((await pool.getData()).epoch).toBe(BigInt(EPOCH + 2));
    expect(await pool.getDrawOpen()).toBe(true); // and the new draw is armed
  });
});