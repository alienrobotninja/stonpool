import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { harvestAmounts } from '../scripts/demo';
import { poolSetup } from '../wrappers/protocol';

// Full-stack depeg propagation (B11.S1). The venue-level socialization is covered in
// mock_stonfi_depeg.spec; this drives it through pool-core -> C6 -> the mock STON.fi pool:
// a reserve shrink (depeg) haircuts every withdrawal by the same rate, and a post-depeg
// harvest yields nothing. Reuses the C6 integration harness (MIN_HOLD 0 so a deposit is
// withdrawable in the same epoch without running the draw).

const OP_TRANSFER = 0x0f8a7ea5, OP_INTERNAL_TRANSFER = 0x178d4519, OP_MINT = 0x00000015;
const OP_DEPOSIT = 0x10000001, OP_REQUEST_WITHDRAW = 0x10000002;
const OP_CONFIGURE_VAULT = 0x10000072, OP_CONFIGURE_CORE = 0x10000073;
const OP_CFG_STONFI_ADAPTER = 0x10000074, OP_CFG_ROUTER = 0x7e571001, OP_CFG_POOL = 0x7e571002;
const OP_SIMULATE_LOSS = 0x7e571005;
const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3, ROLE_GOVERNOR = 4;
const SROLE = { POOL_CORE: 0, OWN_WALLET: 1, ROUTER: 2, LP_WALLET: 3, STONFI_POOL: 4 };

const T0 = 1_000_000, EPOCH = 5, EPOCH_LENGTH = 3600, DEPOSIT_CUTOFF = 600;
const COMMIT_WINDOW = 900, REVEAL_WINDOW = 900, DRAW_BOND = toNano('1');
const SKIM_BPS = 1000, PRIZE_TIERS = 3, MIN_HOLD = 0;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const CFG: Config = { epochLength: EPOCH_LENGTH, depositCutoff: DEPOSIT_CUTOFF, commitWindow: COMMIT_WINDOW, revealWindow: REVEAL_WINDOW, minHoldEpochs: MIN_HOLD, prizeTiers: PRIZE_TIERS, skimBps: SKIM_BPS, drawBond: DRAW_BOND };
const packConfig = (c: Config) => beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32).storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();

const walletData = (bal: bigint, owner: Address, minter: Address) => beginCell().storeCoins(bal).storeAddress(owner).storeAddress(minter).endCell();
const internalTransferStep = (amount: bigint) => beginCell().storeUint(OP_INTERNAL_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(null).storeAddress(null).storeCoins(0).endCell();

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
class StonfiAdapterRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_adapter_data', [])).stack; s.readAddress(); return { principal: s.readBigNumber(), lpBalance: s.readBigNumber() }; }
}
class StonfiPoolRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_pool_data', [])).stack; s.readAddress(); s.readAddressOpt(); return { reserve: s.readBigNumber(), lpSupply: s.readBigNumber() }; }
}

describe('depeg propagates through pool-core: haircut withdrawals, socialized loss (B11.S1)', () => {
  let bc: Blockchain;
  let minterCode: Cell, walletCode: Cell;
  let admin: SandboxContract<TreasuryContract>, minterAdmin: SandboxContract<TreasuryContract>;
  let deps: SandboxContract<TreasuryContract>[];
  let minter: Address, pool: Address, adapter: Address, vault: Address, drawEngine: Address, governor: Address, router: Address, stonfiPool: Address;

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const lpWalletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, stonfiPool) });
  const bal = (owner: Address) => bc.openContract(new Reader(walletOf(owner))).getBalance();
  const poolR = () => bc.openContract(new PoolRead(pool));
  const adapterR = () => bc.openContract(new StonfiAdapterRead(adapter));
  const stonfiPoolR = () => bc.openContract(new StonfiPoolRead(stonfiPool));

  const send = (from: Address, to: Address, value: bigint, body: Cell) => bc.sendMessage(internal({ from, to, value, body }));
  const mint = (to: Address, amount: bigint) =>
    send(minterAdmin.address, minter, toNano('0.5'), beginCell().storeUint(OP_MINT, 32).storeUint(0, 64).storeAddress(to).storeCoins(toNano('0.1')).storeRef(internalTransferStep(amount)).endCell());
  const configureCore = (role: number, addr: Address) => send(admin.address, pool, toNano('0.1'), beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell());
  const wireAdapter = (role: number, addr: Address) => send(admin.address, adapter, toNano('0.1'), beginCell().storeUint(OP_CFG_STONFI_ADAPTER, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell());
  const deposit = (who: SandboxContract<TreasuryContract>, amount: bigint) =>
    send(who.address, walletOf(who.address), toNano('1'), beginCell().storeUint(OP_TRANSFER, 32).storeUint(0, 64).storeCoins(amount).storeAddress(pool).storeAddress(who.address).storeMaybeRef(null).storeCoins(toNano('0.6')).storeUint(OP_DEPOSIT, 32).storeAddress(who.address).endCell());
  const withdraw = (who: SandboxContract<TreasuryContract>, amount: bigint) => send(who.address, pool, toNano('0.5'), beginCell().storeUint(OP_REQUEST_WITHDRAW, 32).storeUint(0, 64).storeCoins(amount).endCell());
  const simulateLoss = (amount: bigint) => send(admin.address, stonfiPool, toNano('0.1'), beginCell().storeUint(OP_SIMULATE_LOSS, 32).storeUint(0, 64).storeCoins(amount).endCell());

  beforeAll(async () => {
    minterCode = loadCode('minter'); walletCode = loadCode('wallet');
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin'); minterAdmin = await bc.treasury('minterAdmin');
    deps = []; for (let i = 0; i < 2; i++) deps.push(await bc.treasury('dep' + i));

    const content = beginCell().storeUint(1, 8).endCell();
    const mInit = { code: minterCode, data: beginCell().storeCoins(0).storeAddress(minterAdmin.address).storeRef(content).storeRef(walletCode).endCell() };
    minter = contractAddress(0, mInit);
    await bc.sendMessage(internal({ from: minterAdmin.address, to: minter, value: toNano('1'), body: beginCell().endCell(), stateInit: mInit }));

    const pInit = { code: loadCode('pool_core'), data: beginCell().storeUint(EPOCH, 32).storeUint(T0 + EPOCH_LENGTH - DEPOSIT_CUTOFF, 32).storeUint(T0, 32).storeCoins(0).storeCoins(0).storeBit(false).storeUint(0, 64).storeAddress(admin.address).storeRef(poolSetup(packConfig(CFG))).storeBit(false).storeBit(false).endCell() };
    pool = contractAddress(0, pInit);
    await bc.sendMessage(internal({ from: admin.address, to: pool, value: toNano('5'), body: beginCell().endCell(), stateInit: pInit }));

    const aInit = { code: loadCode('yield_adapter_stonfi'), data: beginCell().storeAddress(admin.address).storeCoins(0).storeCoins(0).storeUint(0, 16).storeBit(false).endCell() };
    adapter = contractAddress(0, aInit);
    await bc.sendMessage(internal({ from: admin.address, to: adapter, value: toNano('30'), body: beginCell().endCell(), stateInit: aInit }));

    const rInit = { code: loadCode('mock_stonfi_router'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).endCell() };
    router = contractAddress(0, rInit);
    await bc.sendMessage(internal({ from: admin.address, to: router, value: toNano('2'), body: beginCell().endCell(), stateInit: rInit }));

    const spInit = { code: loadCode('mock_stonfi_pool'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell() };
    stonfiPool = contractAddress(0, spInit);
    await bc.sendMessage(internal({ from: admin.address, to: stonfiPool, value: toNano('2'), body: beginCell().endCell(), stateInit: spInit }));

    const vInit = { code: loadCode('jetton_vault'), data: beginCell().storeAddress(admin.address).storeAddress(null).storeAddress(null).storeCoins(0).endCell() };
    vault = contractAddress(0, vInit);
    await bc.sendMessage(internal({ from: admin.address, to: vault, value: toNano('1'), body: beginCell().endCell(), stateInit: vInit }));

    const dInit = { code: loadCode('draw_engine'), data: beginCell().storeAddress(pool).storeUint(0, 32).storeUint(COMMIT_WINDOW, 32).storeUint(REVEAL_WINDOW, 32).storeCoins(DRAW_BOND).storeUint(0, 32).storeUint(0, 32).storeBit(false).storeUint(0, 256).storeBit(false).endCell() };
    drawEngine = contractAddress(0, dInit);
    await bc.sendMessage(internal({ from: admin.address, to: drawEngine, value: toNano('1'), body: beginCell().endCell(), stateInit: dInit }));

    const gInit = { code: loadCode('param_governor'), data: beginCell().storeAddress(admin.address).storeAddress(pool).storeUint(3600, 32).storeUint(0, 32).storeRef(packConfig(CFG)).storeMaybeRef(null).endCell() };
    governor = contractAddress(0, gInit);
    await bc.sendMessage(internal({ from: admin.address, to: governor, value: toNano('1'), body: beginCell().endCell(), stateInit: gInit }));

    await send(admin.address, vault, toNano('0.1'), beginCell().storeUint(OP_CONFIGURE_VAULT, 32).storeUint(0, 64).storeAddress(pool).storeAddress(walletOf(vault)).endCell());
    await configureCore(ROLE_JETTON_WALLET, walletOf(pool));
    await configureCore(ROLE_ADAPTER, adapter);
    await configureCore(ROLE_DRAW_ENGINE, drawEngine);
    await configureCore(ROLE_VAULT, vault);
    await configureCore(ROLE_GOVERNOR, governor);

    await wireAdapter(SROLE.POOL_CORE, pool);
    await wireAdapter(SROLE.OWN_WALLET, walletOf(adapter));
    await wireAdapter(SROLE.ROUTER, router);
    await wireAdapter(SROLE.LP_WALLET, lpWalletOf(adapter));
    await wireAdapter(SROLE.STONFI_POOL, stonfiPool);
    await send(admin.address, router, toNano('0.1'), beginCell().storeUint(OP_CFG_ROUTER, 32).storeUint(0, 64).storeAddress(walletOf(router)).storeAddress(stonfiPool).endCell());
    await send(admin.address, stonfiPool, toNano('0.1'), beginCell().storeUint(OP_CFG_POOL, 32).storeUint(0, 64).storeAddress(router).endCell());

    await mint(deps[0].address, 1000n);
    await mint(deps[1].address, 2000n);
  });

  it('a 20% reserve depeg haircuts both withdrawals to 80% and socializes the loss evenly', async () => {
    await deposit(deps[0], 1000n);
    await deposit(deps[1], 2000n);
    expect(await stonfiPoolR().getData()).toEqual({ reserve: 3000n, lpSupply: 3000n });
    let a = await adapterR().getData();
    expect(a.principal).toBe(3000n);
    expect(a.lpBalance).toBe(3000n);

    // depeg: shrink the reserve by 600 (20%); lpSupply untouched so each LP redeems for less
    await simulateLoss(600n);
    expect((await stonfiPoolR().getData()).reserve).toBe(2400n);

    // a harvest now yields nothing: lp_value(3000) = 2400 <= principal 3000
    const q = await stonfiPoolR().getData();
    expect(harvestAmounts({ principal: 3000n, lpBalance: 3000n }, { reserve: q.reserve, lpSupply: q.lpSupply })).toEqual({ lpToBurn: 0n, gross: 0n });

    // dep0 withdraws 1000 principal -> burns 1000 LP -> venue releases 1000 * 2400/3000 = 800
    const b0 = await bal(deps[0].address);
    await withdraw(deps[0], 1000n);
    const got0 = (await bal(deps[0].address)) - b0;
    expect(got0).toBe(800n);
    expect((await poolR().getData()).totalPrincipal).toBe(2000n); // ledger decrements at face value
    a = await adapterR().getData();
    expect(a.principal).toBe(2000n);
    expect(a.lpBalance).toBe(2000n);

    // dep1 withdraws 2000 -> burns 2000 LP -> releases 2000 * 1600/2000 = 1600
    const b1 = await bal(deps[1].address);
    await withdraw(deps[1], 2000n);
    const got1 = (await bal(deps[1].address)) - b1;
    expect(got1).toBe(1600n);

    // identical haircut rate -> the shortfall is socialized in proportion to principal
    expect(got0 * 2000n).toBe(got1 * 1000n); // 800/1000 == 1600/2000
    a = await adapterR().getData();
    expect(a.principal).toBe(0n);
    expect(a.lpBalance).toBe(0n);
    expect((await stonfiPoolR().getData()).reserve).toBe(0n);
  });
});