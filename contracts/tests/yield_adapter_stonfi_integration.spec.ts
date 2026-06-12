import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

// This is the C7 lifecycle (pool_lifecycle_e2e) with the real STON.fi adapter (C6) and
// the mock STON.fi stack swapped in for the mock adapter. pool-core is byte-identical:
// it wires C6 in ROLE_ADAPTER and drives deposit/withdraw exactly as it drives C7. The
// only operational differences are external to pool-core: C6 holds a TON gas reserve to
// fund the multi-hop STON.fi chains, and yield is harvested by the keeper from the
// off-chain quote (C6 can't price LP on-chain) rather than self-computed at epoch advance.

const OP_TRANSFER = 0x0f8a7ea5, OP_INTERNAL_TRANSFER = 0x178d4519, OP_MINT = 0x00000015;
const OP_DEPOSIT = 0x10000001, OP_REQUEST_WITHDRAW = 0x10000002, OP_ADVANCE_EPOCH = 0x10000004, OP_SETTLE_DRAW = 0x10000016;
const OP_COMMIT = 0x10000011, OP_REVEAL = 0x10000012;
const OP_CONFIGURE_VAULT = 0x10000072, OP_CONFIGURE_CORE = 0x10000073;
const OP_CFG_STONFI_ADAPTER = 0x10000074, OP_HARVEST_STONFI = 0x10000035;
const OP_CFG_ROUTER = 0x7e571001, OP_CFG_POOL = 0x7e571002, OP_ACCRUE = 0x7e571004;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3, ROLE_GOVERNOR = 4;
const SROLE = { POOL_CORE: 0, OWN_WALLET: 1, ROUTER: 2, LP_WALLET: 3, STONFI_POOL: 4 };

const T0 = 1_000_000;
const EPOCH = 5, EPOCH_LENGTH = 3600, DEPOSIT_CUTOFF = 600;
const COMMIT_WINDOW = 900, REVEAL_WINDOW = 900;
const DRAW_BOND = toNano('1');
const SKIM_BPS = 1000, PRIZE_TIERS = 3, MIN_HOLD = 1;
const ACCRUE = 2500n; // STON.fi swap fees accruing to the pool over the epoch

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
class StonfiAdapterRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) {
    const s = (await p.get('get_adapter_data', [])).stack;
    s.readAddress(); const principal = s.readBigNumber(); const lpBalance = s.readBigNumber();
    return { principal, lpBalance };
  }
}
class StonfiPoolRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_pool_data', [])).stack; s.readAddress(); s.readAddressOpt(); return { reserve: s.readBigNumber(), lpSupply: s.readBigNumber() }; }
}
class VaultRead implements Contract {
  constructor(readonly address: Address) {}
  async getPot(p: ContractProvider): Promise<bigint> { const s = (await p.get('get_vault_data', [])).stack; s.readAddress(); s.readAddressOpt(); s.readAddressOpt(); return s.readBigNumber(); }
}

describe('C6 drop-in lifecycle e2e: deposit -> stonfi harvest -> draw -> payout -> withdraw', () => {
  let bc: Blockchain;
  let minterCode: Cell, walletCode: Cell;
  let admin: SandboxContract<TreasuryContract>, minterAdmin: SandboxContract<TreasuryContract>;
  let ca: SandboxContract<TreasuryContract>, cb: SandboxContract<TreasuryContract>;
  let deps: SandboxContract<TreasuryContract>[];
  let minter: Address, pool: Address, adapter: Address, vault: Address, drawEngine: Address, governor: Address;
  let router: Address, stonfiPool: Address;

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const lpWalletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, stonfiPool) });
  const bal = (owner: Address) => bc.openContract(new Reader(walletOf(owner))).getBalance();
  const poolR = () => bc.openContract(new PoolRead(pool));
  const adapterR = () => bc.openContract(new StonfiAdapterRead(adapter));
  const stonfiPoolR = () => bc.openContract(new StonfiPoolRead(stonfiPool));
  const vaultR = () => bc.openContract(new VaultRead(vault));

  const send = (from: Address, to: Address, value: bigint, body: Cell) => bc.sendMessage(internal({ from, to, value, body }));
  const mint = (to: Address, amount: bigint) =>
    send(minterAdmin.address, minter, toNano('0.5'),
      beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(to).storeCoins(toNano('0.1')).storeRef(internalTransferStep(amount)).endCell());
  const configureCore = (role: number, addr: Address) =>
    send(admin.address, pool, toNano('0.1'), beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell());
  const wireAdapter = (role: number, addr: Address) =>
    send(admin.address, adapter, toNano('0.1'), beginCell().storeUint(OP_CFG_STONFI_ADAPTER, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell());
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

    const content = beginCell().storeUint(1, 8).endCell();
    const mInit = { code: minterCode, data: beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell() };
    minter = contractAddress(0, mInit);
    await bc.sendMessage(internal({ from: minterAdmin.address, to: minter, value: toNano('1'), body: beginCell().endCell(), stateInit: mInit }));

    const pInit = { code: loadCode('pool_core'), data: beginCell()
      .storeUint(EPOCH, 32).storeUint(T0 + EPOCH_LENGTH - DEPOSIT_CUTOFF, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0).storeAddress(admin.address).storeRef(packConfig(CFG)).storeBit(false).storeBit(false).endCell() };
    pool = contractAddress(0, pInit);
    await bc.sendMessage(internal({ from: admin.address, to: pool, value: toNano('5'), body: beginCell().endCell(), stateInit: pInit }));

    // C6 with a TON gas reserve to fund the provide/burn chains
    const aInit = { code: loadCode('yield_adapter_stonfi'), data: beginCell().storeAddress(admin.address).storeCoins(0).storeCoins(0).storeUint(0, 16).storeBit(false).endCell() };
    adapter = contractAddress(0, aInit);
    await bc.sendMessage(internal({ from: admin.address, to: adapter, value: toNano('30'), body: beginCell().endCell(), stateInit: aInit }));

    // mock STON.fi router + pool (pool is the LP master)
    const rInit = { code: loadCode('mock_stonfi_router'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).endCell() };
    router = contractAddress(0, rInit);
    await bc.sendMessage(internal({ from: admin.address, to: router, value: toNano('2'), body: beginCell().endCell(), stateInit: rInit }));

    const spInit = { code: loadCode('mock_stonfi_pool'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell() };
    stonfiPool = contractAddress(0, spInit);
    await bc.sendMessage(internal({ from: admin.address, to: stonfiPool, value: toNano('2'), body: beginCell().endCell(), stateInit: spInit }));

    const vInit = { code: loadCode('jetton_vault'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeCoins(0).endCell() };
    vault = contractAddress(0, vInit);
    await bc.sendMessage(internal({ from: admin.address, to: vault, value: toNano('1'), body: beginCell().endCell(), stateInit: vInit }));

    const dInit = { code: loadCode('draw_engine'), data: beginCell()
      .storeAddress(pool).storeUint(0, 32).storeUint(COMMIT_WINDOW, 32).storeUint(REVEAL_WINDOW, 32).storeCoins(DRAW_BOND)
      .storeUint(0, 32).storeUint(0, 32).storeBit(false).storeUint(0, 256).storeBit(false).endCell() };
    drawEngine = contractAddress(0, dInit);
    await bc.sendMessage(internal({ from: admin.address, to: drawEngine, value: toNano('1'), body: beginCell().endCell(), stateInit: dInit }));

    const gInit = { code: loadCode('param_governor'), data: beginCell().storeAddress(admin.address).storeAddress(pool).storeUint(3600, 32).storeUint(0, 32).storeRef(packConfig(CFG)).storeMaybeRef(null).endCell() };
    governor = contractAddress(0, gInit);
    await bc.sendMessage(internal({ from: admin.address, to: governor, value: toNano('1'), body: beginCell().endCell(), stateInit: gInit }));

    // wire pool-core (C6 sits in ROLE_ADAPTER, same slot the mock adapter used)
    await send(admin.address, vault, toNano('0.1'), beginCell().storeUint(OP_CONFIGURE_VAULT, 32).storeUint(0, 64).storeAddress(pool).storeAddress(walletOf(vault)).endCell());
    await configureCore(ROLE_JETTON_WALLET, walletOf(pool));
    await configureCore(ROLE_ADAPTER, adapter);
    await configureCore(ROLE_DRAW_ENGINE, drawEngine);
    await configureCore(ROLE_VAULT, vault);
    await configureCore(ROLE_GOVERNOR, governor);

    // wire C6 roles + the mock STON.fi stack
    await wireAdapter(SROLE.POOL_CORE, pool);
    await wireAdapter(SROLE.OWN_WALLET, walletOf(adapter));
    await wireAdapter(SROLE.ROUTER, router);
    await wireAdapter(SROLE.LP_WALLET, lpWalletOf(adapter));
    await wireAdapter(SROLE.STONFI_POOL, stonfiPool);
    await send(admin.address, router, toNano('0.1'), beginCell().storeUint(OP_CFG_ROUTER, 32).storeUint(0, 64).storeAddress(walletOf(router)).storeAddress(stonfiPool).endCell());
    await send(admin.address, stonfiPool, toNano('0.1'), beginCell().storeUint(OP_CFG_POOL, 32).storeUint(0, 64).storeAddress(router).endCell());

    await mint(deps[0].address, 1000n);
    await mint(deps[1].address, 2000n);
    await mint(deps[2].address, 3000n);
    await mint(deps[3].address, 4000n);
  });

  const SA = 0xa11ce0n, SB = 0xb0b0n;

  it('deposits route principal through C6 into a single-sided STON.fi position', async () => {
    await deposit(deps[0], 1000n);
    await deposit(deps[1], 2000n);
    await deposit(deps[2], 3000n);
    await deposit(deps[3], 4000n);
    expect((await poolR().getData()).totalPrincipal).toBe(10000n);
    expect((await poolR().getBalanceOf(deps[2].address)).weight).toBe(3000n);
    const a = await adapterR().getData();
    expect(a.principal).toBe(10000n);
    expect(a.lpBalance).toBe(10000n);     // single-sided LP minted 1:1 on the bootstrap pool
    const sp = await stonfiPoolR().getData();
    expect(sp.reserve).toBe(10000n);
    expect(sp.lpSupply).toBe(10000n);
    expect(await bal(router)).toBe(10000n); // underlying now in the router vault
  });

  it('keeper harvests accrued STON.fi yield into the vault pot', async () => {
    // STON.fi earns swap fees: real underlying lands in the router vault, and the pool
    // marks it as reserve growth (lpSupply unchanged, so each LP redeems for more).
    await mint(router, ACCRUE);
    await send(admin.address, stonfiPool, toNano('0.1'), beginCell().storeUint(OP_ACCRUE, 32).storeUint(0, 64).storeCoins(ACCRUE).endCell());

    // size the harvest the way the off-chain indexer would, from get_lp_quote
    const sp = await stonfiPoolR().getData();
    const principal = (await adapterR().getData()).principal;
    const grossYield = sp.reserve - principal;               // 2500
    const lpToBurn = (grossYield * sp.lpSupply) / sp.reserve; // 2000
    const release = (lpToBurn * sp.reserve) / sp.lpSupply;    // 2500

    await send(admin.address, adapter, toNano('2'),
      beginCell().storeUint(OP_HARVEST_STONFI, 32).storeUint(0, 64).storeCoins(lpToBurn).storeCoins(release).storeAddress(vault).endCell());

    expect(await vaultR().getPot()).toBe(release);            // yield reached the vault
    expect((await poolR().getData()).prizePot).toBe(release); // and the report credited the pot
    const a = await adapterR().getData();
    expect(a.principal).toBe(10000n);                         // principal untouched
    expect(a.lpBalance).toBe(8000n);                          // only the yield-LP burned
  });

  it('commit-reveal-settle pays tiered prizes from the vault to winners', async () => {
    const commit = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, DRAW_BOND + toNano('0.2'), beginCell().storeUint(OP_COMMIT, 32).storeUint(0, 64).storeUint(commitHashOf(secret), 256).endCell());
    const reveal = (c: SandboxContract<TreasuryContract>, secret: bigint) =>
      send(c.address, drawEngine, toNano('0.2'), beginCell().storeUint(OP_REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell());

    bc.now = T0 + EPOCH_LENGTH;
    await send(admin.address, pool, toNano('1'), beginCell().storeUint(OP_ADVANCE_EPOCH, 32).storeUint(0, 64).endCell());
    expect((await poolR().getData()).prizePot).toBe(ACCRUE); // epoch-advance harvest is a zero ack; pot unchanged

    bc.now = T0 + EPOCH_LENGTH + 10;
    await commit(ca, SA); await commit(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW;
    await reveal(ca, SA); await reveal(cb, SB);
    bc.now = T0 + EPOCH_LENGTH + COMMIT_WINDOW + REVEAL_WINDOW;
    await send(admin.address, pool, toNano('1'), beginCell().storeUint(OP_SETTLE_DRAW, 32).storeUint(0, 64).endCell());

    const seed = mixSeed(mixSeed(0n, SA), SB);
    const skim = (ACCRUE * BigInt(SKIM_BPS)) / 10000n;     // 250
    const distributable = ACCRUE - skim;                  // 2250
    expect(await bal(admin.address)).toBe(skim);
    const prizeBals = await Promise.all(deps.map((d) => bal(d.address)));
    const winners = deps.filter((_, i) => prizeBals[i] > 0n);
    expect(winners).toHaveLength(PRIZE_TIERS);
    expect(prizeBals.reduce((a, x) => a + x, 0n)).toBe(distributable);
    const w0 = await poolR().getPreviewWinner(h256(beginCell().storeUint(seed, 256).storeUint(0, 32).endCell()));
    expect(deps.some((d) => d.address.equals(w0))).toBe(true);
    expect((await poolR().getData()).prizePot).toBe(0n);
  });

  it('no-loss: every depositor redeems full principal out of the STON.fi position', async () => {
    const principals = [1000n, 2000n, 3000n, 4000n];
    const before = await Promise.all(deps.map((d) => bal(d.address)));
    for (let i = 0; i < deps.length; i++) {
      await send(deps[i].address, pool, toNano('0.5'), beginCell().storeUint(OP_REQUEST_WITHDRAW, 32).storeUint(0, 64).storeCoins(principals[i]).endCell());
    }
    for (let i = 0; i < deps.length; i++) {
      expect(await bal(deps[i].address)).toBe(before[i] + principals[i]);
      expect((await poolR().getBalanceOf(deps[i].address)).weight).toBe(0n);
    }
    expect((await poolR().getData()).totalPrincipal).toBe(0n);
    const a = await adapterR().getData();
    expect(a.principal).toBe(0n);
    expect(a.lpBalance).toBe(0n);
    expect((await stonfiPoolR().getData()).reserve).toBe(0n);
  });
});