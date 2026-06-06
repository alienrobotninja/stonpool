import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_TRANSFER = 0x0f8a7ea5;
const OP_DEPOSIT = 0x10000001;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_WRONG_SENDER = 402;
const ERR_DEPOSIT_CLOSED = 410;

const ROLE_JETTON_WALLET = 0;
const ROLE_ADAPTER = 1;

const T0 = 1_000_000;
const EPOCH = 5;
const DEADLINE = T0 + 100_000;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const CFG: Config = { epochLength: 86400, depositCutoff: 3600, commitWindow: 1800, revealWindow: 1800, minHoldEpochs: 0, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };

function packConfig(c: Config): Cell {
  return beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();
}
const intArg = (n: bigint) => ({ type: 'int' as const, value: n });
const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
  }
  async getData(p: ContractProvider) {
    const s = (await p.get('get_pool_data', [])).stack;
    return { epoch: s.readBigNumber(), depositDeadline: s.readBigNumber(), totalPrincipal: s.readBigNumber(), prizePot: s.readBigNumber() };
  }
  async getBalanceOf(p: ContractProvider, who: Address) {
    const s = (await p.get('get_balance_of', [addrArg(who)])).stack;
    return { weight: s.readBigNumber(), joinEpoch: s.readBigNumber() };
  }
  async getCount(p: ContractProvider): Promise<bigint> { return (await p.get('get_participant_count', [])).stack.readBigNumber(); }
  async getTotalWeight(p: ContractProvider): Promise<bigint> { return (await p.get('get_total_weight', [])).stack.readBigNumber(); }
  async getOdds(p: ContractProvider, who: Address): Promise<bigint> { return (await p.get('get_odds', [addrArg(who)])).stack.readBigNumber(); }
  async getWinner(p: ContractProvider, word: bigint): Promise<Address> { return (await p.get('preview_winner', [intArg(word)])).stack.readAddress(); }
}

describe('C1 pool-core deposit path + reads', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let jw: SandboxContract<TreasuryContract>;   // stands in for pool-core's jetton wallet
  let adapter: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let stranger: SandboxContract<TreasuryContract>;
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  function poolData(): Cell {
    return beginCell()
      .storeUint(EPOCH, 32).storeUint(DEADLINE, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0)
      .storeAddress(admin.address)
      .storeRef(packConfig(CFG))
      .storeBit(false).storeBit(false) // empty wiring + ledger maps
      .endCell();
  }

  async function fresh(configure = true): Promise<SandboxContract<Pool>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    jw = await bc.treasury('jw');
    adapter = await bc.treasury('adapter');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');
    stranger = await bc.treasury('stranger');
    const init = { code, data: poolData() };
    const p = bc.openContract(new Pool(contractAddress(0, init), init));
    await p.sendDeploy(admin.getSender());
    if (configure) {
      await p.sendConfigure(admin.getSender(), ROLE_JETTON_WALLET, jw.address);
      await p.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    }
    return p;
  }

  // simulate pool-core's jetton wallet delivering a deposit notification
  async function deposit(amount: bigint, depositor: Address, beneficiary?: Address, from: Address = jw.address) {
    let b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(depositor);
    if (beneficiary) b = b.storeUint(OP_DEPOSIT, 32).storeAddress(beneficiary);
    return bc.sendMessage(internal({ from, to: pool.address, value: 300_000_000n, body: b.endCell() }));
  }

  it('credits the depositor by default and tracks total principal', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    expect(await pool.getBalanceOf(alice.address)).toEqual({ weight: 1000n, joinEpoch: BigInt(EPOCH) });
    expect((await pool.getData()).totalPrincipal).toBe(1000n);
    expect(await pool.getCount()).toBe(1n);
  });

  it('credits an explicit beneficiary from the forward payload', async () => {
    pool = await fresh();
    await deposit(2500n, alice.address, bob.address); // alice pays, bob credited
    expect((await pool.getBalanceOf(bob.address)).weight).toBe(2500n);
    expect((await pool.getBalanceOf(alice.address)).weight).toBe(0n);
  });

  it('accumulates repeated deposits and keeps the original joinEpoch', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    await deposit(500n, alice.address);
    expect(await pool.getBalanceOf(alice.address)).toEqual({ weight: 1500n, joinEpoch: BigInt(EPOCH) });
    expect(await pool.getCount()).toBe(1n);
  });

  it('forwards principal to the adapter tagged for yield', async () => {
    pool = await fresh();
    const r = await deposit(1000n, alice.address);
    // pool-core instructs its jetton wallet to transfer to the adapter
    expect(r.transactions).toHaveTransaction({ from: pool.address, to: jw.address, op: OP_TRANSFER });
  });

  it('rejects a deposit after the cutoff (410)', async () => {
    pool = await fresh();
    bc.now = DEADLINE;
    const r = await deposit(1000n, alice.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_DEPOSIT_CLOSED });
  });

  it('rejects a notification from a non-wallet sender (402)', async () => {
    pool = await fresh();
    const r = await deposit(1000n, alice.address, undefined, stranger.address);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_WRONG_SENDER });
  });

  it('C2 reads run on the real ledger', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    await deposit(3000n, bob.address);
    expect(await pool.getTotalWeight()).toBe(4000n);            // minHold 0 -> both eligible
    expect(await pool.getOdds(alice.address)).toBe(2500n);      // 1000/4000
    expect(await pool.getOdds(bob.address)).toBe(7500n);
    const w = await pool.getWinner(0n);                          // deterministic, a real depositor
    expect([alice.address.toString(), bob.address.toString()]).toContain(w.toString());
  });
});