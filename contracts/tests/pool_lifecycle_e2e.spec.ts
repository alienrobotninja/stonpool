import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

// ops
const OP_TRANSFER = 0x0f8a7ea5, OP_INTERNAL_TRANSFER = 0x178d4519, OP_MINT = 0x00000015;
const OP_DEPOSIT = 0x10000001, OP_REQUEST_WITHDRAW = 0x10000002, OP_ADVANCE_EPOCH = 0x10000004, OP_SETTLE_DRAW = 0x10000016;
const OP_COMMIT = 0x10000011, OP_REVEAL = 0x10000012;
const OP_CONFIGURE_ADAPTER = 0x10000071, OP_CONFIGURE_VAULT = 0x10000072, OP_CONFIGURE_CORE = 0x10000073;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3, ROLE_GOVERNOR = 4;

const T0 = 1_000_000;
const EPOCH = 5, EPOCH_LENGTH = 3600, DEPOSIT_CUTOFF = 600;
const COMMIT_WINDOW = 900, REVEAL_WINDOW = 900;
const DRAW_BOND = toNano('1');
const YIELD_BPS = 1000, SKIM_BPS = 1000, PRIZE_TIERS = 3, MIN_HOLD = 1;

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
  async getBalanceOf(p: ContractProvider, who: Address) { const s = (await p.get('get_balance_of', [addrArg(who)])).stack; return { weight: s.readBigNumber(), joinEpoch: s.readBigNumber() }; }
  async getPreviewWinner(p: ContractProvider, word: bigint): Promise<Address> { return (await p.get('preview_winner', [{ type: 'int', value: word }])).stack.readAddress(); }
}
class AdapterRead implements Contract {
  constructor(readonly address: Address) {}
  async getPrincipal(p: ContractProvider): Promise<bigint> { const s = (await p.get('get_adapter_data', [])).stack; s.readAddress(); s.readAddressOpt(); s.readAddressOpt(); s.readBigNumber(); return s.readBigNumber(); }
}
class VaultRead implements Contract {
  constructor(readonly address: Address) {}
  async getPot(p: ContractProvider): Promise<bigint> { const s = (await p.get('get_vault_data', [])).stack; s.readAddress(); s.readAddressOpt(); s.readAddressOpt(); return s.readBigNumber(); }
}

describe('Full pool lifecycle e2e: deposit -> harvest -> draw -> payout -> withdraw', () => {
  let bc: Blockchain;
  let minterCode: Cell, walletCode: Cell;
  let admin: SandboxContract<TreasuryContract>, minterAdmin: SandboxContract<TreasuryContract>;
  let ca: SandboxContract<TreasuryContract>, cb: SandboxContract<TreasuryContract>; // committers
  let deps: SandboxContract<TreasuryContract>[];
  let minter: Address, pool: Address, adapter: Address, vault: Address, drawEngine: Address, governor: Address;

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const bal = (owner: Address) => bc.openContract(new Reader(walletOf(owner))).getBalance();
  const poolR = () => bc.openContract(new PoolRead(pool));
  const adapterR = () => bc.openContract(new AdapterRead(adapter));
  const vaultR = () => bc.openContract(new VaultRead(vault));

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
  // depositor sends a TEP-74 transfer (their wallet -> pool wallet) tagging the deposit
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
    deps = []; for (let i = 0; i < 4; i++) deps.push(await bc.treasury('dep' + i));

    // deploy minter
    const content = beginCell().storeUint(1, 8).endCell();
    const mInit = { code: minterCode, data: beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell() };
    minter = contractAddress(0, mInit);
    await send(minterAdmin.address, minter, toNano('0.5'), beginCell().endCell()); // top-up (deploy via stateInit below)
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

    // fund: depositors get stable; adapter gets a yield reserve
    await mint(deps[0].address, 1000n);
    await mint(deps[1].address, 2000n);
    await mint(deps[2].address, 3000n);
    await mint(deps[3].address, 4000n);
    await mint(adapter, 5000n); // untagged -> held as reserve (principal unchanged)
  });

  const SA = 0xa11ce0n, SB = 0xb0b0n;

  it('deposits credit the ledger and route principal into the adapter', async () => {
    await deposit(deps[0], 1000n);
    await deposit(deps[1], 2000n);
    await deposit(deps[2], 3000n);
    await deposit(deps[3], 4000n);
    expect((await poolR().getData()).totalPrincipal).toBe(10000n);
    expect((await poolR().getBalanceOf(deps[2].address)).weight).toBe(3000n);
    // principal physically routed to the adapter via the tagged forward chain
    expect(await adapterR().getPrincipal()).toBe(10000n);
  });

  it('advancing the epoch harvests yield into the vault pot and opens the draw', async () => {
    bc.now = T0 + EPOCH_LENGTH;
    await send(admin.address, pool, toNano('1'), beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell());
    const yieldAmt = (10000n * BigInt(YIELD_BPS)) / 10000n; // 1000
    expect(await vaultR().getPot()).toBe(yieldAmt);            // harvested jettons reached the vault
    expect((await poolR().getData()).prizePot).toBe(yieldAmt); // and the report credited the pot
  });

  it('commit-reveal-settle delivers the seed and pays tiered prizes from the vault to winners', async () => {
    const commit = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, DRAW_BOND + toNano('0.2'), beginCell().storeUint(OP_COMMIT, 32).storeUint(0, 64).storeUint(commitHashOf(secret), 256).endCell());
    const reveal = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, toNano('0.2'), beginCell().storeUint(OP_REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell());

    bc.now = T0 + EPOCH_LENGTH + 10;                 // commit window
    await commit(ca, SA); await commit(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW;       // reveal window
    await reveal(ca, SA); await reveal(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW + REVEAL_WINDOW; // reveal closed

    // scheduler settles -> draw finalizes -> DrawResult -> pool selects + pays
    await send(admin.address, pool, toNano('1'), beginCell().storeUint(OP_SETTLE_DRAW, 32).storeUint(0, 64).endCell());

    const seed = mixSeed(mixSeed(0n, SA), SB);
    const skim = (1000n * BigInt(SKIM_BPS)) / 10000n;       // 100
    const distributable = 1000n - skim;                    // 900
    const perTier = distributable / BigInt(PRIZE_TIERS);    // 300

    // admin (skim) credited in stable
    expect(await bal(admin.address)).toBe(skim);
    // exactly 3 distinct depositors won a prize
    const prizeBals = await Promise.all(deps.map((d) => bal(d.address)));
    const winners = deps.filter((_, i) => prizeBals[i] > 0n);
    expect(winners).toHaveLength(PRIZE_TIERS);
    const totalPrize = prizeBals.reduce((a, x) => a + x, 0n);
    expect(totalPrize).toBe(distributable);
    // the top-tier winner matches the on-chain selection for tierWord(seed, 0)
    const w0 = await poolR().getPreviewWinner(h256(beginCell().storeUint(seed, 256).storeUint(0, 32).endCell()));
    expect(deps.some((d) => d.address.equals(w0))).toBe(true);
    expect((await poolR().getData()).prizePot).toBe(0n); // pot fully distributed
  });

  it('no-loss: every depositor recovers their full principal on withdraw', async () => {
    const principals = [1000n, 2000n, 3000n, 4000n];
    const before = await Promise.all(deps.map((d) => bal(d.address))); // prize winnings so far
    for (let i = 0; i < deps.length; i++) {
      await send(deps[i].address, pool, toNano('0.5'), beginCell().storeUint(OP_REQUEST_WITHDRAW, 32).storeUint(0, 64).storeCoins(principals[i]).endCell());
    }
    for (let i = 0; i < deps.length; i++) {
      const after = await bal(deps[i].address);
      expect(after).toBe(before[i] + principals[i]); // principal fully returned, on top of any prize
      expect((await poolR().getBalanceOf(deps[i].address)).weight).toBe(0n);
    }
    expect((await poolR().getData()).totalPrincipal).toBe(0n);
  });
});