import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

// Gas regression for the settle -> finalize -> payout chain.
//
// On testnet the pre-fix constants (SETTLE_GAS=0.2, DRAW_RESULT_GAS=0.5) left the
// payout loop unable to fund its own Payout sends once the tier count grew: the
// action phase aborted mid-loop, so the draw read "finalized" but the vault never
// paid out all winners. Bring-up needed a manual 2 TON top-up to the draw-engine.
//
// The sandbox normally hides this because the lifecycle e2e funds everything with
// round toNano('1') values. This spec reproduces the real condition by (a) driving
// a high prizeTiers count so the payout loop is long, and (b) sending the settle
// with realistic constrained gas rather than a fat buffer. Under the old constants
// the total distributed prize falls short of `distributable`; under the fix it lands
// exactly.

const OP_TRANSFER = 0x0f8a7ea5, OP_INTERNAL_TRANSFER = 0x178d4519, OP_MINT = 0x00000015;
const OP_DEPOSIT = 0x10000001, OP_ADVANCE_EPOCH = 0x10000004, OP_SETTLE_DRAW = 0x10000016;
const OP_COMMIT = 0x10000011, OP_REVEAL = 0x10000012;
const OP_CONFIGURE_ADAPTER = 0x10000071, OP_CONFIGURE_VAULT = 0x10000072, OP_CONFIGURE_CORE = 0x10000073;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3, ROLE_GOVERNOR = 4;

const T0 = 1_000_000;
const EPOCH = 5, EPOCH_LENGTH = 3600, DEPOSIT_CUTOFF = 600;
const COMMIT_WINDOW = 900, REVEAL_WINDOW = 900;
const DRAW_BOND = toNano('1');
// high tier count is the point: 6 payout sends + skim send stresses the payout gas
const YIELD_BPS = 2000, SKIM_BPS = 1000, PRIZE_TIERS = 6, MIN_HOLD = 1;
const NUM_DEPS = 6;

// constrained settle gas: enough for a correctly-sized chain, not the fat toNano('1')
// the lifecycle e2e uses. This is roughly what an operator would actually attach.
const SETTLE_MSG_VALUE = toNano('0.5');

const h256 = (c: Cell) => BigInt('0x' + c.hash().toString('hex'));
const commitHashOf = (secret: bigint) => h256(beginCell().storeUint(secret, 256).endCell());
const mixSeed = (seed: bigint, secret: bigint) => h256(beginCell().storeUint(seed, 256).storeUint(secret, 256).endCell());

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const CFG: Config = { epochLength: EPOCH_LENGTH, depositCutoff: DEPOSIT_CUTOFF, commitWindow: COMMIT_WINDOW, revealWindow: REVEAL_WINDOW, minHoldEpochs: MIN_HOLD, prizeTiers: PRIZE_TIERS, skimBps: SKIM_BPS, drawBond: DRAW_BOND };
const packConfig = (c: Config) => beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32).storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();

const walletData = (bal: bigint, owner: Address, minter: Address) => beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();
const internalTransferStep = (amount: bigint) => beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(null).storeAddress(null).storeCoins(0).endCell();
const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class Reader implements Contract {
  constructor(readonly address: Address) {}
  async getBalance(p: ContractProvider): Promise<bigint> {
    try { return (await p.get('get_wallet_data', [])).stack.readBigNumber(); } catch { return 0n; }
  }
}
class PoolRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_pool_data', [])).stack; return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() }; }
}
class VaultRead implements Contract {
  constructor(readonly address: Address) {}
  async getPot(p: ContractProvider): Promise<bigint> { const s = (await p.get('get_vault_data', [])).stack; s.readAddress(); s.readAddressOpt(); s.readAddressOpt(); return s.readBigNumber(); }
}
class DrawRead implements Contract {
  constructor(readonly address: Address) {}
  async getPhase(p: ContractProvider): Promise<bigint> { return (await p.get('get_phase', [])).stack.readBigNumber(); }
}

describe('settle gas regression: payout completes under constrained gas with high tier count', () => {
  let bc: Blockchain;
  let minterCode: Cell, walletCode: Cell;
  let admin: SandboxContract<TreasuryContract>, minterAdmin: SandboxContract<TreasuryContract>;
  let ca: SandboxContract<TreasuryContract>, cb: SandboxContract<TreasuryContract>;
  let deps: SandboxContract<TreasuryContract>[];
  let minter: Address, pool: Address, adapter: Address, vault: Address, drawEngine: Address, governor: Address;

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const bal = (owner: Address) => bc.openContract(new Reader(walletOf(owner))).getBalance();
  const poolR = () => bc.openContract(new PoolRead(pool));
  const vaultR = () => bc.openContract(new VaultRead(vault));
  const drawR = () => bc.openContract(new DrawRead(drawEngine));

  const send = (from: Address, to: Address, value: bigint, body: Cell) => bc.sendMessage(internal({ from, to, value, body }));
  const mint = (to: Address, amount: bigint) =>
    send(minterAdmin.address, minter, toNano('0.5'),
      beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(to).storeCoins(toNano('0.1')).storeRef(internalTransferStep(amount)).endCell());
  const configure = (to: Address, op: number, ...addrs: Address[]) => {
    let b = beginCell().storeUint(op, 32).storeUint(0, 64);
    for (const a of addrs) b = b.storeAddress(a);
    return send(admin.address, to, toNano('0.1'), b.endCell());
  };
  const configureCore = (role: number, addr: Address) =>
    send(admin.address, pool, toNano('0.1'), beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell());
  const deposit = (who: SandboxContract<TreasuryContract>, amount: bigint) =>
    send(who.address, walletOf(who.address), toNano('1'),
      beginCell().storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount)
        .storeAddress(pool).storeAddress(who.address).storeMaybeRef(null).storeCoins(toNano('0.6'))
        .storeUint(OP_DEPOSIT, 32).storeAddress(who.address).endCell());

  beforeAll(async () => {
    minterCode = loadCode('minter'); walletCode = loadCode('wallet');
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin'); minterAdmin = await bc.treasury('minterAdmin');
    ca = await bc.treasury('committerA'); cb = await bc.treasury('committerB');
    deps = []; for (let i = 0; i < NUM_DEPS; i++) deps.push(await bc.treasury('dep' + i));

    // deploy minter
    const content = beginCell().storeUint(1, 8).endCell();
    const mInit = { code: minterCode, data: beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell() };
    minter = contractAddress(0, mInit);
    await bc.sendMessage(internal({ from: minterAdmin.address, to: minter, value: toNano('1'), body: beginCell().endCell(), stateInit: mInit }));

    // deploy pool-core
    const pInit = { code: loadCode('pool_core'), data: beginCell()
      .storeUint(EPOCH, 32).storeUint(T0 + EPOCH_LENGTH - DEPOSIT_CUTOFF, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0).storeAddress(admin.address).storeRef(packConfig(CFG)).storeBit(false).storeBit(false).endCell() };
    pool = contractAddress(0, pInit);
    await bc.sendMessage(internal({ from: admin.address, to: pool, value: toNano('5'), body: beginCell().endCell(), stateInit: pInit }));

    // deploy adapter
    const aInit = { code: loadCode('mock_adapter'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeUint(YIELD_BPS, 16).storeCoins(0).endCell() };
    adapter = contractAddress(0, aInit);
    await bc.sendMessage(internal({ from: admin.address, to: adapter, value: toNano('1'), body: beginCell().endCell(), stateInit: aInit }));

    // deploy vault
    const vInit = { code: loadCode('jetton_vault'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeCoins(0).endCell() };
    vault = contractAddress(0, vInit);
    await bc.sendMessage(internal({ from: admin.address, to: vault, value: toNano('1'), body: beginCell().endCell(), stateInit: vInit }));

    // deploy draw-engine (poolCore-gated)
    const dInit = { code: loadCode('draw_engine'), data: beginCell()
      .storeAddress(pool).storeUint(0, 32).storeUint(COMMIT_WINDOW, 32).storeUint(REVEAL_WINDOW, 32).storeCoins(DRAW_BOND)
      .storeUint(0, 32).storeUint(0, 32).storeBit(false).storeUint(0, 256).storeBit(false).endCell() };
    drawEngine = contractAddress(0, dInit);
    await bc.sendMessage(internal({ from: admin.address, to: drawEngine, value: toNano('1'), body: beginCell().endCell(), stateInit: dInit }));

    // deploy governor
    const gInit = { code: loadCode('param_governor'), data: beginCell().storeAddress(admin.address).storeAddress(pool).storeUint(3600, 32).storeUint(0, 32).storeRef(packConfig(CFG)).storeMaybeRef(null).endCell() };
    governor = contractAddress(0, gInit);
    await bc.sendMessage(internal({ from: admin.address, to: governor, value: toNano('1'), body: beginCell().endCell(), stateInit: gInit }));

    // wire
    await configure(adapter, OP_CONFIGURE_ADAPTER, pool, walletOf(adapter));
    await configure(vault, OP_CONFIGURE_VAULT, pool, walletOf(vault));
    await configureCore(ROLE_JETTON_WALLET, walletOf(pool));
    await configureCore(ROLE_ADAPTER, adapter);
    await configureCore(ROLE_DRAW_ENGINE, drawEngine);
    await configureCore(ROLE_VAULT, vault);
    await configureCore(ROLE_GOVERNOR, governor);

    // fund: each depositor gets equal stable so all NUM_DEPS are eligible winners
    for (let i = 0; i < NUM_DEPS; i++) await mint(deps[i].address, 1000n);
    await mint(adapter, 10000n); // reserve so the harvest has yield to move
  });

  const SA = 0xa11ce0n, SB = 0xb0b0n;

  it('deposits credit all depositors', async () => {
    for (let i = 0; i < NUM_DEPS; i++) await deposit(deps[i], 1000n);
    expect((await poolR().getData()).totalPrincipal).toBe(BigInt(NUM_DEPS) * 1000n);
  });

  it('advance harvests yield into the pot and opens the draw', async () => {
    bc.now = T0 + EPOCH_LENGTH;
    await send(admin.address, pool, toNano('1'), beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell());
    const yieldAmt = (BigInt(NUM_DEPS) * 1000n * BigInt(YIELD_BPS)) / 10000n;
    expect((await poolR().getData()).prizePot).toBe(yieldAmt);
  });

  it('settle under constrained gas pays every tier in full', async () => {
    const commit = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, DRAW_BOND + toNano('0.2'), beginCell().storeUint(OP_COMMIT, 32).storeUint(0, 64).storeUint(commitHashOf(secret), 256).endCell());
    const reveal = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, toNano('0.2'), beginCell().storeUint(OP_REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell());

    bc.now = T0 + EPOCH_LENGTH + 10;
    await commit(ca, SA); await commit(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW;
    await reveal(ca, SA); await reveal(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW + REVEAL_WINDOW;

    const potBefore = await vaultR().getPot();

    // THE REGRESSION POINT: settle with realistic constrained gas, not toNano('1').
    // Under old constants (0.2/0.5) the 6-tier payout loop runs dry and the vault
    // pays out less than `distributable`; under the fix it pays out in full.
    await send(admin.address, pool, SETTLE_MSG_VALUE, beginCell().storeUint(OP_SETTLE_DRAW, 32).storeUint(0, 64).endCell());

    const pot = (BigInt(NUM_DEPS) * 1000n * BigInt(YIELD_BPS)) / 10000n;
    const skim = (pot * BigInt(SKIM_BPS)) / 10000n;
    const distributable = pot - skim;

    // draw finalized
    expect(await drawR().getPhase()).toBe(4n);
    // pool zeroed the pot (payout messages were emitted)
    expect((await poolR().getData()).prizePot).toBe(0n);
    // every tier actually paid: total winnings across depositors equals distributable,
    // and the vault pot dropped by the full distributable amount. This is what fails
    // under the old gas (partial payout) and passes under the fix.
    const prizeBals = await Promise.all(deps.map((d) => bal(d.address)));
    const totalPrize = prizeBals.reduce((a, x) => a + x, 0n);
    expect(totalPrize).toBe(distributable);
    expect(await vaultR().getPot()).toBe(potBefore - distributable - skim);
  });
});