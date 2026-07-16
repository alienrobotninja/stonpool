import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_DRAW_RESULT = 0x10000014;
const OP_HARVEST_YIELD = 0x10000033;
const OP_PARAMS_UPDATED = 0x10000043;
const OP_REQUEST_WITHDRAW = 0x10000002;
const OP_ADVANCE_EPOCH = 0x10000004;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_UNAUTHORIZED = 401;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3, ROLE_GOVERNOR = 4;

const T0 = 2_000_000;
const JOIN = 5;
const EPOCH_LENGTH = 3600;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const base: Config = { epochLength: EPOCH_LENGTH, depositCutoff: 600, commitWindow: 900, revealWindow: 900, minHoldEpochs: 0, prizeTiers: 3, skimBps: 1000, drawBond: 1_000_000_000n };
function packConfig(c: Config): Cell {
  return beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();
}
function unpackConfig(cell: Cell): Config {
  const s = cell.beginParse();
  return { epochLength: s.loadUint(32), depositCutoff: s.loadUint(32), commitWindow: s.loadUint(32), revealWindow: s.loadUint(32), minHoldEpochs: s.loadUint(16), prizeTiers: s.loadUint(8), skimBps: s.loadUint(16), drawBond: s.loadCoins() };
}
const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
  }
  async sendAdvance(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 600_000_000n, body: beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell() });
  }
  async getConfig(p: ContractProvider): Promise<Config> { return unpackConfig((await p.get('get_config', [])).stack.readCell()); }
  async getTotalWeight(p: ContractProvider): Promise<bigint> { return (await p.get('get_total_weight', [])).stack.readBigNumber(); }
  async getData(p: ContractProvider) {
    const s = (await p.get('get_pool_data', [])).stack;
    return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() };
  }
  async getBalanceOf(p: ContractProvider, who: Address) {
    const s = (await p.get('get_balance_of', [addrArg(who)])).stack;
    return { weight: s.readBigNumber(), joinEpoch: s.readBigNumber() };
  }
}

describe('C1 pool-core hardening + governor integration', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let jw: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<TreasuryContract>;
  let drawEngine: SandboxContract<TreasuryContract>;
  let vault: SandboxContract<TreasuryContract>;
  let governor: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  async function fresh(cfg: Config = base): Promise<SandboxContract<Pool>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    jw = await bc.treasury('jw');
    adapter = await bc.treasury('adapter');
    drawEngine = await bc.treasury('drawEngine');
    vault = await bc.treasury('vault');
    governor = await bc.treasury('governor');
    stranger = await bc.treasury('stranger');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');
    const init = { code, data: beginCell()
      .storeUint(JOIN, 32).storeUint(T0 + 100_000, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0).storeBit(false).storeUint(0, 64).storeAddress(admin.address)
      .storeRef(packConfig(cfg)).storeBit(false).storeBit(false).storeBit(false).endCell() };
    const p = bc.openContract(new Pool(contractAddress(0, init), init));
    await p.sendDeploy(admin.getSender());
    await p.sendConfigure(admin.getSender(), ROLE_JETTON_WALLET, jw.address);
    await p.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    await p.sendConfigure(admin.getSender(), ROLE_DRAW_ENGINE, drawEngine.address);
    await p.sendConfigure(admin.getSender(), ROLE_VAULT, vault.address);
    await p.sendConfigure(admin.getSender(), ROLE_GOVERNOR, governor.address);
    return p;
  }

  const deposit = (amount: bigint, who: Address, from: Address = jw.address) =>
    bc.sendMessage(internal({ from, to: pool.address, value: 300_000_000n,
      body: beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(who).endCell() }));
  const paramsUpdated = (cfg: Config, from: Address = governor.address) =>
    bc.sendMessage(internal({ from, to: pool.address, value: 100_000_000n,
      body: beginCell().storeUint(OP_PARAMS_UPDATED, 32).storeUint(0, 64).storeSlice(packConfig(cfg).beginParse()).endCell() }));
  const report = (amount: bigint, from: Address = adapter.address) =>
    bc.sendMessage(internal({ from, to: pool.address, value: 100_000_000n,
      body: beginCell().storeUint(OP_ADAPTER_REPORT, 32).storeUint(0, 64).storeUint(OP_HARVEST_YIELD, 32).storeCoins(0).storeCoins(amount).storeBit(true).endCell() }));
  const drawResult = (seed: bigint, from: Address = drawEngine.address) =>
    bc.sendMessage(internal({ from, to: pool.address, value: 1_500_000_000n,
      body: beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64).storeUint(JOIN, 32).storeUint(seed, 256).endCell() }));

  it('governor ParamsUpdated swaps the live config and takes effect immediately', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address); // joinEpoch == currentEpoch == JOIN
    expect(await pool.getTotalWeight()).toBe(1000n);          // minHold 0 -> eligible
    await paramsUpdated({ ...base, minHoldEpochs: 1 });
    expect((await pool.getConfig()).minHoldEpochs).toBe(1);
    expect(await pool.getTotalWeight()).toBe(0n);             // held 0 < 1 -> now ineligible
  });

  it('rejects ParamsUpdated from a non-governor sender (401)', async () => {
    pool = await fresh();
    const r = await paramsUpdated({ ...base, minHoldEpochs: 9 }, stranger.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getConfig()).minHoldEpochs).toBe(0);   // unchanged
  });

  it('a draw result from the adapter (wrong wired role) is rejected (401)', async () => {
    pool = await fresh();
    const r = await drawResult(0x1n, adapter.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
  });

  it('an adapter report from the draw-engine (wrong wired role) is rejected (401)', async () => {
    pool = await fresh();
    const r = await report(5_000n, drawEngine.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getData()).prizePot).toBe(0n);
  });

  it('accounting invariants hold across deposit -> advance -> harvest -> payout -> withdraw', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    await deposit(2000n, bob.address);
    expect((await pool.getData()).totalPrincipal).toBe(3000n);

    bc.now = T0 + EPOCH_LENGTH;
    await pool.sendAdvance(admin.getSender()); // epoch JOIN -> JOIN+1; depositors now eligible

    await report(900n);                         // harvest credits the pot
    expect((await pool.getData()).prizePot).toBe(900n);

    const r = await drawResult(0xabcn);         // distribute
    expect((await pool.getData()).prizePot).toBe(0n); // pot fully distributed
    const paid = r.transactions
      .flatMap((tx) => Array.from(tx.outMessages.values()))
      .filter((m: any) => m.info?.dest && m.info.dest.equals(vault.address) && m.body)
      .map((m: any) => { const s = m.body.beginParse(); s.loadUint(32); s.loadUint(64); s.loadAddress(); return s.loadCoins() as bigint; })
      .reduce((a: bigint, x: bigint) => a + x, 0n);
    expect(paid).toBe(900n);                    // skim + tiers == pot

    // principal is independent of prizes: withdraw still reflects deposits
    await bc.sendMessage(internal({ from: alice.address, to: pool.address, value: 300_000_000n,
      body: beginCell().storeUint(OP_REQUEST_WITHDRAW, 32).storeUint(0, 64).storeCoins(1000n).endCell() }));
    expect((await pool.getData()).totalPrincipal).toBe(2000n);
    expect((await pool.getBalanceOf(alice.address)).weight).toBe(0n);
  });
});