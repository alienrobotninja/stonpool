import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_DRAW_RESULT = 0x10000014;
const OP_PAYOUT = 0x10000005;
const OP_HARVEST_YIELD = 0x10000033;
const OP_CONFIGURE_CORE = 0x10000073;
const OP_ADVANCE_EPOCH = 0x10000004;

const ERR_UNAUTHORIZED = 401;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3;

const T0 = 2_000_000;
const EPOCH = 6;       // depositors joined epoch 5 (held 1 >= minHold 1) -> eligible
const JOIN = 5;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const CFG: Config = { epochLength: 3600, depositCutoff: 600, commitWindow: 900, revealWindow: 900, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1000, drawBond: 1_000_000_000n };
function packConfig(c: Config): Cell {
  return beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();
}
const h256 = (c: Cell): bigint => BigInt('0x' + c.hash().toString('hex'));
const tierWord = (seed: bigint, tier: number) => h256(beginCell().storeUint(seed, 256).storeUint(tier, 32).endCell());

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
  }
  async sendAdvance(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 600_000_000n, body: beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell() });
  }
  async getData(p: ContractProvider) {
    const s = (await p.get('get_pool_data', [])).stack;
    return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() };
  }
  // the coupled gas budget the contract actually ships (contracts/gas.tolk)
  async getGasBudget(p: ContractProvider) {
    const s = (await p.get('get_gas_budget', [])).stack;
    return { settleGas: s.readBigNumber(), drawResultGas: s.readBigNumber(), payoutGas: s.readBigNumber(), maxPrizeTiers: s.readBigNumber() };
  }
}

// decode a Payout body -> {to, amount}
function decodePayout(body: Cell): { to: Address; amount: bigint } {
  const s = body.beginParse();
  s.loadUint(32); s.loadUint(64);
  return { to: s.loadAddress(), amount: s.loadCoins() };
}

describe('C1 pool-core draw-result consumption + tiered payout', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let jw: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<TreasuryContract>;
  let drawEngine: SandboxContract<TreasuryContract>;
  let vault: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let depositors: SandboxContract<TreasuryContract>[];
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  async function depositAt(amount: bigint, who: Address, joinViaEpoch: number) {
    const b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(who).endCell();
    return bc.sendMessage(internal({ from: jw.address, to: pool.address, value: 300_000_000n, body: b }));
  }

  // parametrized so the tier sweep can vary prizeTiers and the depositor count;
  // setup() keeps the original 3-tier / 4-depositor fixture the other tests assume
  async function setupWith(cfg: Config, numDeps: number): Promise<void> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    jw = await bc.treasury('jw');
    adapter = await bc.treasury('adapter');
    drawEngine = await bc.treasury('drawEngine');
    vault = await bc.treasury('vault');
    stranger = await bc.treasury('stranger');
    depositors = [];
    for (let i = 0; i < numDeps; i++) depositors.push(await bc.treasury('dep' + i));

    // deploy at currentEpoch = JOIN so deposits get joinEpoch = JOIN
    const init = { code, data: beginCell()
      .storeUint(JOIN, 32).storeUint(T0 + 100_000, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0).storeAddress(admin.address)
      .storeRef(packConfig(cfg)).storeBit(false).storeBit(false).endCell() };
    pool = bc.openContract(new Pool(contractAddress(0, init), init));
    await pool.sendDeploy(admin.getSender());
    await pool.sendConfigure(admin.getSender(), ROLE_JETTON_WALLET, jw.address);
    await pool.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    await pool.sendConfigure(admin.getSender(), ROLE_DRAW_ENGINE, drawEngine.address);
    await pool.sendConfigure(admin.getSender(), ROLE_VAULT, vault.address);

    // deposits land at epoch JOIN with distinct weights
    for (let i = 0; i < numDeps; i++) await depositAt(BigInt((i + 1) * 1000), depositors[i].address, JOIN);

    // close epoch JOIN -> currentEpoch becomes JOIN+1, depositors now held 1 epoch (eligible)
    bc.now = T0 + cfg.epochLength;
    await pool.sendAdvance(admin.getSender());
  }

  async function setup(): Promise<void> { return setupWith(CFG, 4); }

  async function harvest(amount: bigint, from: Address = adapter.address) {
    // AdapterReportMsg { queryId, report{ reportedOp, principal, yieldAmount, success } }
    const body = beginCell().storeUint(OP_ADAPTER_REPORT, 32).storeUint(0, 64)
      .storeUint(OP_HARVEST_YIELD, 32).storeCoins(0).storeCoins(amount).storeBit(true).endCell();
    return bc.sendMessage(internal({ from, to: pool.address, value: 100_000_000n, body }));
  }

  async function deliverDraw(seed: bigint, from: Address = drawEngine.address) {
    // DrawResultMsg { queryId, result{ epoch, seed } }
    const body = beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64).storeUint(JOIN, 32).storeUint(seed, 256).endCell();
    return bc.sendMessage(internal({ from, to: pool.address, value: 1_500_000_000n, body }));
  }

  // pull every Payout emitted to the vault out of a tx trace
  function payoutsOf(r: any): { to: Address; amount: bigint }[] {
    return r.transactions
      .flatMap((tx: any) => Array.from(tx.outMessages.values()))
      .filter((m: any) => m.info?.dest && m.info.dest.equals(vault.address) && m.body)
      .map((m: any) => decodePayout(m.body));
  }

  it('harvest report credits the prize pot', async () => {
    await setup();
    await harvest(10_000n);
    expect((await pool.getData()).prizePot).toBe(10_000n);
  });

  it('harvest report from a non-adapter sender is rejected (401)', async () => {
    await setup();
    const r = await harvest(10_000n, stranger.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getData()).prizePot).toBe(0n);
  });

  it('draw result pays skim + 3 distinct tier winners summing to the pot, then zeroes it', async () => {
    await setup();
    const POT = 10_000n;
    await harvest(POT);
    const seed = 0x1234abcdn;
    const r = await deliverDraw(seed);

    const payouts = payoutsOf(r);
    const skim = (POT * BigInt(CFG.skimBps)) / 10000n; // 1000
    const distributable = POT - skim;                  // 9000

    // one skim payout to admin
    const skimPay = payouts.find((p) => p.to.equals(admin.address));
    expect(skimPay?.amount).toBe(skim);

    // tier payouts to distinct depositors
    const tierPays = payouts.filter((p) => !p.to.equals(admin.address));
    expect(tierPays).toHaveLength(CFG.prizeTiers);
    const winnerSet = new Set(tierPays.map((p) => p.to.toString()));
    expect(winnerSet.size).toBe(CFG.prizeTiers); // distinct

    // amounts sum to distributable, each winner is a real depositor
    const sum = tierPays.reduce((a, p) => a + p.amount, 0n);
    expect(sum).toBe(distributable);
    const depSet = new Set(depositors.map((d) => d.address.toString()));
    for (const p of tierPays) expect(depSet.has(p.to.toString())).toBe(true);

    // pot zeroed after distribution
    expect((await pool.getData()).prizePot).toBe(0n);
  });

  it('draw result from a non-draw-engine sender is rejected (401)', async () => {
    await setup();
    await harvest(10_000n);
    const r = await deliverDraw(0x1n, stranger.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
    expect((await pool.getData()).prizePot).toBe(10_000n); // untouched
  });

  it('tier-0 absorbs the division remainder (exact distribution)', async () => {
    await setup();
    const POT = 10_001n; // skim 1000 -> distributable 9001, /3 = 3000 r1
    await harvest(POT);
    const r = await deliverDraw(0x55n);
    const tierPays = payoutsOf(r).filter((p) => !p.to.equals(admin.address));
    const sum = tierPays.reduce((a, p) => a + p.amount, 0n);
    expect(sum).toBe(9001n);                         // no dust lost
    expect(tierPays.some((p) => p.amount === 3001n)).toBe(true); // tier-0 got the remainder
  });

  // BUG-1 structural guard. The three constants in contracts/gas.tolk are a coupled
  // set; the original bug was them drifting apart across two contract files. These
  // are the two relationships that must hold, asserted against the values the
  // contract actually ships (not a copy maintained here).
  it('gas budget invariants hold', async () => {
    await setup();
    const g = await pool.getGasBudget();

    // 1. DRAW_RESULT_GAS must fund pool-core's whole payout loop: one Payout send per
    //    tier plus one skim send, all SEND_MODE_REGULAR out of the incoming value.
    expect(g.drawResultGas).toBeGreaterThanOrEqual(g.payoutGas * (g.maxPrizeTiers + 1n));

    // 2. SETTLE_GAS must cover the DrawResultMsg draw-engine forwards back. That send
    //    is SEND_MODE_PAY_FEES_SEPARATELY, i.e. paid from draw-engine's OWN balance:
    //    if SETTLE_GAS < DRAW_RESULT_GAS the draw-engine subsidizes every settle and
    //    drains, which is what forced the manual 2 TON top-up during bring-up.
    expect(g.settleGas).toBeGreaterThanOrEqual(g.drawResultGas);
  });

  // BUG-1 regression: the real DrawResultMsg carries only `slashed + DRAW_RESULT_GAS`.
  // With slashed = 0 (all revealers honest) that is exactly DRAW_RESULT_GAS. The old
  // 0.5 TON allowance ran the pool-core payout loop dry mid-distribution and the action
  // phase aborted silently, leaving the pot half-paid. Deliver the draw funded with the
  // contract's REAL shipped DRAW_RESULT_GAS and assert the whole payout completes.
  it('full payout completes when the draw carries only the shipped DRAW_RESULT_GAS', async () => {
    await setup();
    const POT = 10_000n;
    await harvest(POT);
    const g = await pool.getGasBudget();

    const seed = 0x1234abcdn;
    const body = beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64).storeUint(JOIN, 32).storeUint(seed, 256).endCell();
    const r = await bc.sendMessage(internal({ from: drawEngine.address, to: pool.address, value: g.drawResultGas, body }));

    // the pool-core transaction that consumed the draw must succeed (not abort in action phase)
    expect(r.transactions).toHaveTransaction({ to: pool.address, from: drawEngine.address, success: true });

    const payouts = payoutsOf(r);
    const skim = (POT * BigInt(CFG.skimBps)) / 10000n;
    const tierPays = payouts.filter((p) => !p.to.equals(admin.address));

    // all sends fired: 1 skim + prizeTiers winners, summing to the full pot
    expect(payouts.find((p) => p.to.equals(admin.address))?.amount).toBe(skim);
    expect(tierPays).toHaveLength(CFG.prizeTiers);
    expect(tierPays.reduce((a, p) => a + p.amount, 0n)).toBe(POT - skim);
    expect((await pool.getData()).prizePot).toBe(0n);
  });

  // The payout loop's gas cost scales with prizeTiers, which is governor-settable.
  // DRAW_RESULT_GAS is sized in gas.tolk for MAX_PRIZE_TIERS; sweep the range to prove
  // the budget holds at every tier count up to that ceiling, funded with only the
  // shipped constant. This is what documents why DRAW_RESULT_GAS is the size it is.
  it.each([1, 3, 6, 8])('payout completes for prizeTiers=%i on the shipped DRAW_RESULT_GAS', async (tiers) => {
    await setupWith({ ...CFG, prizeTiers: tiers }, 8);
    const POT = 10_000n;
    await harvest(POT);
    const g = await pool.getGasBudget();
    expect(BigInt(tiers)).toBeLessThanOrEqual(g.maxPrizeTiers); // sweep stays inside the budgeted ceiling

    const body = beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64).storeUint(JOIN, 32).storeUint(0xabcdn, 256).endCell();
    const r = await bc.sendMessage(internal({ from: drawEngine.address, to: pool.address, value: g.drawResultGas, body }));

    expect(r.transactions).toHaveTransaction({ to: pool.address, from: drawEngine.address, success: true });

    const payouts = payoutsOf(r);
    const skim = (POT * BigInt(CFG.skimBps)) / 10000n;
    const tierPays = payouts.filter((p) => !p.to.equals(admin.address));

    expect(tierPays).toHaveLength(tiers);
    expect(new Set(tierPays.map((p) => p.to.toString())).size).toBe(tiers); // distinct winners
    expect(tierPays.reduce((a, p) => a + p.amount, 0n)).toBe(POT - skim);   // nothing lost mid-loop
    expect((await pool.getData()).prizePot).toBe(0n);
  });
});