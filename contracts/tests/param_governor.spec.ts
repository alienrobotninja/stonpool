import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_PROPOSE = 0x10000041;
const OP_EXECUTE = 0x10000042;
const OP_PARAMS_UPDATED = 0x10000043;
const ERR_UNAUTHORIZED = 401;
const ERR_TIMELOCK_ACTIVE = 440;
const ERR_INVALID_PARAMS = 441;
const ERR_NOTHING_PENDING = 442;

const T0 = 1_000_000;
const TIMELOCK = 3600;

type Config = {
  epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number;
  minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint;
};

const C0: Config = { epochLength: 86400, depositCutoff: 82800, commitWindow: 3600, revealWindow: 3600, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };
const C1: Config = { epochLength: 43200, depositCutoff: 40000, commitWindow: 1800, revealWindow: 1800, minHoldEpochs: 2, prizeTiers: 5, skimBps: 1000, drawBond: 2_000_000_000n };

function packConfig(c: Config): Cell {
  return beginCell()
    .storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32)
    .storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8)
    .storeUint(c.skimBps, 16).storeCoins(c.drawBond)
    .endCell();
}
function unpackConfig(cell: Cell): Config {
  const s = cell.beginParse();
  return {
    epochLength: s.loadUint(32), depositCutoff: s.loadUint(32),
    commitWindow: s.loadUint(32), revealWindow: s.loadUint(32),
    minHoldEpochs: s.loadUint(16), prizeTiers: s.loadUint(8),
    skimBps: s.loadUint(16), drawBond: s.loadCoins(),
  };
}

class Gov implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() });
  }
  async sendPropose(p: ContractProvider, via: Sender, c: Config) {
    const body = beginCell().storeUint(OP_PROPOSE, 32).storeUint(0, 64).storeSlice(packConfig(c).beginParse()).endCell();
    await p.internal(via, { value: 100_000_000n, body });
  }
  async sendExecute(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 200_000_000n, body: beginCell().storeUint(OP_EXECUTE, 32).storeUint(0, 64).endCell() });
  }
  async getConfig(p: ContractProvider): Promise<Config> {
    return unpackConfig((await p.get('get_config', [])).stack.readCell());
  }
  async getPending(p: ContractProvider): Promise<Config | null> {
    const c = (await p.get('get_pending', [])).stack.readCellOpt();
    return c ? unpackConfig(c) : null;
  }
  async getData(p: ContractProvider) {
    const st = (await p.get('get_governor_data', [])).stack;
    return { admin: st.readAddress(), poolCore: st.readAddress(), timelock: st.readBigNumber(), executeAfter: st.readBigNumber() };
  }
}

function govData(admin: Address, poolCore: Address): Cell {
  return beginCell()
    .storeAddress(admin).storeAddress(poolCore)
    .storeUint(TIMELOCK, 32).storeUint(0, 32)
    .storeRef(packConfig(C0)).storeMaybeRef(null)
    .endCell();
}

describe('C8 param-governor', () => {
  let bc: Blockchain;
  let admin: SandboxContract<TreasuryContract>;
  let poolCore: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;

  beforeAll(() => {});

  async function fresh(): Promise<SandboxContract<Gov>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    poolCore = await bc.treasury('poolCore');
    stranger = await bc.treasury('stranger');
    const init = { code: loadCode('param_governor'), data: govData(admin.address, poolCore.address) };
    const g = bc.openContract(new Gov(contractAddress(0, init), init));
    await g.sendDeploy(admin.getSender());
    return g;
  }

  async function proposed(): Promise<SandboxContract<Gov>> {
    const g = await fresh();
    await g.sendPropose(admin.getSender(), C1);
    return g;
  }

  it('deploys with the active config and no pending', async () => {
    const g = await fresh();
    expect(await g.getConfig()).toEqual(C0);
    expect(await g.getPending()).toBeNull();
    const d = await g.getData();
    expect(d.admin.equals(admin.address)).toBe(true);
    expect(d.timelock).toBe(BigInt(TIMELOCK));
    expect(d.executeAfter).toBe(0n);
  });

  it('admin proposes: stages pending behind the timelock, active config unchanged', async () => {
    const g = await proposed();
    expect(await g.getPending()).toEqual(C1);
    expect(await g.getConfig()).toEqual(C0); // not applied yet
    expect((await g.getData()).executeAfter).toBe(BigInt(T0 + TIMELOCK));
  });

  it('rejects a propose from a non-admin', async () => {
    const g = await fresh();
    const r = await g.sendPropose(stranger.getSender(), C1);
    expect(r.transactions).toHaveTransaction({ to: g.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect(await g.getPending()).toBeNull();
  });

  it('rejects an invalid config (skimBps > 100%)', async () => {
    const g = await fresh();
    const bad = { ...C1, skimBps: 10001 };
    const r = await g.sendPropose(admin.getSender(), bad);
    expect(r.transactions).toHaveTransaction({ to: g.address, success: false, exitCode: ERR_INVALID_PARAMS });
  });

  it('rejects execute before the timelock elapses', async () => {
    const g = await proposed();
    bc.now = T0 + TIMELOCK - 1;
    const r = await g.sendExecute(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: g.address, success: false, exitCode: ERR_TIMELOCK_ACTIVE });
    expect(await g.getConfig()).toEqual(C0);
  });

  it('rejects execute with nothing pending', async () => {
    const g = await fresh();
    const r = await g.sendExecute(admin.getSender());
    expect(r.transactions).toHaveTransaction({ to: g.address, success: false, exitCode: ERR_NOTHING_PENDING });
  });

  it('executes after the timelock: applies config, clears pending, notifies poolCore', async () => {
    const g = await proposed();
    bc.now = T0 + TIMELOCK;
    const r = await g.sendExecute(admin.getSender());
    expect(await g.getConfig()).toEqual(C1);
    expect(await g.getPending()).toBeNull();
    expect((await g.getData()).executeAfter).toBe(0n);
    const expectedBody = beginCell().storeUint(OP_PARAMS_UPDATED, 32).storeUint(0, 64).storeSlice(packConfig(C1).beginParse()).endCell();
    expect(r.transactions).toHaveTransaction({ from: g.address, to: poolCore.address, body: expectedBody });
  });

  it('rejects execute from a non-admin', async () => {
    const g = await proposed();
    bc.now = T0 + TIMELOCK;
    const r = await g.sendExecute(stranger.getSender());
    expect(r.transactions).toHaveTransaction({ to: g.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });
});