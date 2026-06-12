import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_ADVANCE_EPOCH = 0x10000004;
const OP_HARVEST_YIELD = 0x10000033;
const OP_RUN_DRAW = 0x10000013;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_UNAUTHORIZED = 401;
const ERR_EPOCH_NOT_ENDED = 420;

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
});