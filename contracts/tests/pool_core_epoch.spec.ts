import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_ADVANCE_EPOCH = 0x10000004;
const OP_HARVEST_YIELD = 0x10000033;
const OP_RUN_DRAW = 0x10000013;
const OP_DRAW_RESULT = 0x10000014;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_UNAUTHORIZED = 401;
const ERR_EPOCH_NOT_ENDED = 420;
const ERR_BUSY = 451;

const ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3;

const T0 = 1_000_000;
const EPOCH = 5;
const EPOCH_LENGTH = 3600;
const DEPOSIT_CUTOFF = 600;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const CFG: Config = { epochLength: EPOCH_LENGTH, depositCutoff: DEPOSIT_CUTOFF, commitWindow: 900, revealWindow: 900, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };
function packConfig(c: Config): Cell {
  return beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();
}

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
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
    return beginCell()
      .storeUint(EPOCH, 32).storeUint(T0 + EPOCH_LENGTH - DEPOSIT_CUTOFF, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0)
      .storeBit(false) // drawOpen
      .storeAddress(admin.address)
      .storeRef(packConfig(CFG))
      .storeBit(false).storeBit(false)
      .endCell();
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