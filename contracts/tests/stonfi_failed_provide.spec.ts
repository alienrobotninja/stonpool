import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Address, toNano } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { poolSetup } from '../wrappers/protocol';

// Failed-provide accounting consistency (B11.S2). The venue-level slippage guard (811) is
// covered in mock_stonfi_provide; this documents the adapter-path consequence. C6 books
// principal and reports it to pool-core BEFORE the LP mint settles, and every leg is sent
// NoBounce. So a provide that reverts (here: a deposit below the per-LP price mints 0 LP,
// tripping the adapter's minLpOut=1) leaves principal booked but LP-unbacked - the design
// does not unwind. This test pins that behavior rather than asserting it is repaired.

const OP_TRANSFER = 0x0f8a7ea5, OP_INTERNAL_TRANSFER = 0x178d4519, OP_MINT = 0x00000015;
const OP_DEPOSIT = 0x10000001;
const OP_CONFIGURE_VAULT = 0x10000072, OP_CONFIGURE_CORE = 0x10000073;
const OP_CFG_STONFI_ADAPTER = 0x10000074, OP_CFG_ROUTER = 0x7e571001, OP_CFG_POOL = 0x7e571002;
const OP_ACCRUE = 0x7e571004;
const ERR_SLIPPAGE = 811;
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
const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class PoolRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_pool_data', [])).stack; return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() }; }
  async getBalanceOf(p: ContractProvider, who: Address) { const s = (await p.get('get_balance_of', [addrArg(who)])).stack; return { weight: s.readBigNumber(), joinEpoch: s.readBigNumber() }; }
}
class StonfiAdapterRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_adapter_data', [])).stack; s.readAddress(); return { principal: s.readBigNumber(), lpBalance: s.readBigNumber() }; }
}
class StonfiPoolRead implements Contract {
  constructor(readonly address: Address) {}
  async getData(p: ContractProvider) { const s = (await p.get('get_pool_data', [])).stack; s.readAddress(); s.readAddressOpt(); return { reserve: s.readBigNumber(), lpSupply: s.readBigNumber() }; }
}

describe('failed provide leaves principal booked but LP-unbacked (B11.S2)', () => {
  let bc: Blockchain;
  let minterCode: Cell, walletCode: Cell;
  let admin: SandboxContract<TreasuryContract>, minterAdmin: SandboxContract<TreasuryContract>;
  let deps: SandboxContract<TreasuryContract>[];
  let minter: Address, pool: Address, adapter: Address, vault: Address, drawEngine: Address, governor: Address, router: Address, stonfiPool: Address;

  const walletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, minter) });
  const lpWalletOf = (owner: Address) => contractAddress(0, { code: walletCode, data: walletData(0n, owner, stonfiPool) });
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
  const accrue = (amount: bigint) => send(admin.address, stonfiPool, toNano('0.1'), beginCell().storeUint(OP_ACCRUE, 32).storeUint(0, 64).storeCoins(amount).endCell());

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
    await mint(deps[1].address, 10n);
  });

  it('a sub-price deposit mints 0 LP: provide reverts 811, yet principal is still booked', async () => {
    await deposit(deps[0], 1000n);
    expect(await stonfiPoolR().getData()).toEqual({ reserve: 1000n, lpSupply: 1000n });

    // grow the reserve without new LP so the per-LP price climbs to 4
    await accrue(3000n);
    expect(await stonfiPoolR().getData()).toEqual({ reserve: 4000n, lpSupply: 1000n });

    const before = await adapterR().getData();
    expect(before).toEqual({ principal: 1000n, lpBalance: 1000n });

    // deposit 3 < price 4: lpForDeposit(3, 4000, 1000) = 0, below the adapter's minLpOut=1
    const res = await deposit(deps[1], 3n);
    expect(res.transactions).toHaveTransaction({ to: stonfiPool, success: false, exitCode: ERR_SLIPPAGE });

    // principal booked and the depositor credited, but no LP minted -> booked-but-unbacked
    const after = await adapterR().getData();
    expect(after.principal).toBe(1003n);
    expect(after.lpBalance).toBe(1000n); // unchanged: the provide leg reverted, nothing unwound
    expect((await poolR().getData()).totalPrincipal).toBe(1003n);
    expect((await poolR().getBalanceOf(deps[1].address)).weight).toBe(3n);
    expect((await stonfiPoolR().getData()).lpSupply).toBe(1000n); // venue minted nothing
  });
});