import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_REQUEST_WITHDRAW = 0x10000002;
const OP_WITHDRAW_PRINCIPAL = 0x10000032;
const OP_ADAPTER_REPORT = 0x10000034;
const OP_CONFIGURE_CORE = 0x10000073;

const ERR_UNAUTHORIZED = 401;
const ERR_WITHDRAW_TOO_EARLY = 411;
const ERR_NOTHING_TO_WITHDRAW = 412;

const ROLE_JETTON_WALLET = 0;
const ROLE_ADAPTER = 1;

const T0 = 1_000_000;
const EPOCH = 5;
const DEADLINE = T0 + 100_000;

type Config = { epochLength: number; depositCutoff: number; commitWindow: number; revealWindow: number; minHoldEpochs: number; prizeTiers: number; skimBps: number; drawBond: bigint };
const base: Config = { epochLength: 86400, depositCutoff: 3600, commitWindow: 1800, revealWindow: 1800, minHoldEpochs: 0, prizeTiers: 3, skimBps: 1500, drawBond: 1_000_000_000n };

function packConfig(c: Config): Cell {
  return beginCell().storeUint(c.epochLength, 32).storeUint(c.depositCutoff, 32).storeUint(c.commitWindow, 32).storeUint(c.revealWindow, 32)
    .storeUint(c.minHoldEpochs, 16).storeUint(c.prizeTiers, 8).storeUint(c.skimBps, 16).storeCoins(c.drawBond).endCell();
}
const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

class Pool implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) { await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() }); }
  async sendConfigure(p: ContractProvider, via: Sender, role: number, addr: Address) {
    await p.internal(via, { value: 50_000_000n, body: beginCell().storeUint(OP_CONFIGURE_CORE, 32).storeUint(0, 64).storeUint(role, 8).storeAddress(addr).endCell() });
  }
  async sendWithdraw(p: ContractProvider, via: Sender, amount: bigint, queryId = 0, value = 300_000_000n) {
    await p.internal(via, { value, body: beginCell().storeUint(OP_REQUEST_WITHDRAW, 32).storeUint(queryId, 64).storeCoins(amount).endCell() });
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
  async getPending(p: ContractProvider, queryId: number) {
    const s = (await p.get('get_pending', [{ type: 'int' as const, value: BigInt(queryId) }])).stack;
    return { who: s.readAddressOpt(), amount: s.readBigNumber(), joinEpoch: s.readBigNumber() };
  }
  async getNonce(p: ContractProvider): Promise<bigint> { return (await p.get('get_withdraw_nonce', [])).stack.readBigNumber(); }
}

// what pool-core should hand the adapter: its own queryId, not the caller's
const withdrawPrincipalBody = (queryId: number, amount: bigint, to: Address) =>
  beginCell().storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeUint(queryId, 64).storeCoins(amount).storeAddress(to).endCell();

// Address carries methods, so toEqual on a whole record compares functions too and
// fails with "serializes to the same string" even when the values match
function expectPending(got: { who: Address | null; amount: bigint; joinEpoch: bigint }, who: Address, amount: bigint, joinEpoch: number) {
  expect(got.who).toEqualAddress(who);
  expect(got.amount).toBe(amount);
  expect(got.joinEpoch).toBe(BigInt(joinEpoch));
}

describe('C1 pool-core withdraw path', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let jw: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  function poolData(cfg: Config): Cell {
    return beginCell()
      .storeUint(EPOCH, 32).storeUint(DEADLINE, 32).storeUint(T0, 32)
      .storeCoins(0).storeCoins(0)
      .storeBit(false).storeUint(0, 64).storeAddress(admin.address)
      .storeRef(packConfig(cfg))
      .storeBit(false).storeBit(false).storeBit(false)
      .endCell();
  }

  async function fresh(cfg: Config = base): Promise<SandboxContract<Pool>> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    jw = await bc.treasury('jw');
    adapter = await bc.treasury('adapter');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');
    const init = { code, data: poolData(cfg) };
    const p = bc.openContract(new Pool(contractAddress(0, init), init));
    await p.sendDeploy(admin.getSender());
    await p.sendConfigure(admin.getSender(), ROLE_JETTON_WALLET, jw.address);
    await p.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    return p;
  }

  async function deposit(amount: bigint, depositor: Address) {
    const b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(amount).storeAddress(depositor).endCell();
    return bc.sendMessage(internal({ from: jw.address, to: pool.address, value: 300_000_000n, body: b }));
  }

  it('full withdraw debits the ledger, removes the entry, and instructs the adapter', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    const r = await pool.sendWithdraw(alice.getSender(), 1000n);
    expect(r.transactions).toHaveTransaction({ from: pool.address, to: adapter.address, op: OP_WITHDRAW_PRINCIPAL });
    expect(await pool.getBalanceOf(alice.address)).toEqual({ weight: 0n, joinEpoch: 0n }); // entry gone
    expect((await pool.getData()).totalPrincipal).toBe(0n);
    expect(await pool.getCount()).toBe(0n);
  });

  it('partial withdraw debits and keeps the remaining balance + joinEpoch', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    await pool.sendWithdraw(alice.getSender(), 400n);
    expect(await pool.getBalanceOf(alice.address)).toEqual({ weight: 600n, joinEpoch: BigInt(EPOCH) });
    expect((await pool.getData()).totalPrincipal).toBe(600n);
  });

  it('withdraw only debits the caller, not other depositors', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    await deposit(2000n, bob.address);
    await pool.sendWithdraw(alice.getSender(), 1000n);
    expect((await pool.getBalanceOf(bob.address)).weight).toBe(2000n);
    expect((await pool.getData()).totalPrincipal).toBe(2000n);
  });

  it('rejects withdraw with no deposit (412)', async () => {
    pool = await fresh();
    const r = await pool.sendWithdraw(alice.getSender(), 100n);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_NOTHING_TO_WITHDRAW });
  });

  it('rejects over-withdraw and leaves the balance intact (412)', async () => {
    pool = await fresh();
    await deposit(1000n, alice.address);
    const r = await pool.sendWithdraw(alice.getSender(), 1001n);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_NOTHING_TO_WITHDRAW });
    expect((await pool.getBalanceOf(alice.address)).weight).toBe(1000n);
  });

  it('rejects withdraw before the min-hold threshold (411)', async () => {
    pool = await fresh({ ...base, minHoldEpochs: 2 }); // joinEpoch == currentEpoch -> held 0 < 2
    await deposit(1000n, alice.address);
    const r = await pool.sendWithdraw(alice.getSender(), 1000n);
    expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_WITHDRAW_TOO_EARLY });
    expect((await pool.getBalanceOf(alice.address)).weight).toBe(1000n); // untouched
  });

  describe('pending-withdrawal journal', () => {
    // report the adapter would send back. The real adapters echo the queryId pool-core
    // sent them (mock_adapter line 96) - that echo is what makes the ack addressable.
    const ack = (queryId: number, success = true, from: Address = adapter.address) =>
      bc.sendMessage(internal({ from, to: pool.address, value: 100_000_000n,
        body: beginCell().storeUint(OP_ADAPTER_REPORT, 32).storeUint(queryId, 64)
          .storeUint(OP_WITHDRAW_PRINCIPAL, 32).storeCoins(0).storeCoins(0).storeBit(success).endCell() }));

    it('journals the debit in the same transaction that performs it', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 1000n);
      // the ledger entry is gone, but the journal still holds everything needed to undo it
      expect(await pool.getBalanceOf(alice.address)).toEqual({ weight: 0n, joinEpoch: 0n });
      expectPending(await pool.getPending(0), alice.address, 1000n, EPOCH);
    });

    it('a partial withdraw journals only the amount leaving', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 400n);
      expectPending(await pool.getPending(0), alice.address, 400n, EPOCH);
      expect((await pool.getBalanceOf(alice.address)).weight).toBe(600n);
    });

    it('keys the journal on its own nonce, not the caller-supplied queryId', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      const r = await pool.sendWithdraw(alice.getSender(), 1000n, 7);
      // the caller said 7; pool-core must overwrite it with the nonce it keyed the map on,
      // or the ack comes back addressed to an entry that does not exist
      expect(r.transactions).toHaveTransaction({
        from: pool.address, to: adapter.address, body: withdrawPrincipalBody(0, 1000n, alice.address),
      });
      expect((await pool.getPending(0)).who).toEqualAddress(alice.address);
      expect((await pool.getPending(7)).who).toBeNull();
    });

    it('two depositors reusing one queryId get separate journal entries', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await deposit(2000n, bob.address);
      await pool.sendWithdraw(alice.getSender(), 1000n, 7);
      await pool.sendWithdraw(bob.getSender(), 2000n, 7); // same queryId, deliberately
      expectPending(await pool.getPending(0), alice.address, 1000n, EPOCH);
      expectPending(await pool.getPending(1), bob.address, 2000n, EPOCH);
      expect(await pool.getNonce()).toBe(2n);
    });

    it('the adapter ack clears the entry it names and leaves the rest alone', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await deposit(2000n, bob.address);
      await pool.sendWithdraw(alice.getSender(), 1000n);
      await pool.sendWithdraw(bob.getSender(), 2000n);
      const r = await ack(0);
      expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
      expect((await pool.getPending(0)).who).toBeNull();
      expect((await pool.getPending(1)).who).toEqualAddress(bob.address);
    });

    it('the nonce keeps climbing after an ack, so a cleared key is never reused', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 400n);
      await ack(0);
      await pool.sendWithdraw(alice.getSender(), 600n);
      // an entry at 0 here would mean the key came from the map's size, and a
      // late ack for the first withdrawal would clear the second one's record
      expect((await pool.getPending(0)).who).toBeNull();
      expect((await pool.getPending(1)).who).toEqualAddress(alice.address);
    });

    it('an ack for an unknown queryId is a no-op, not a failure', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 1000n);
      const r = await ack(99);
      expect(r.transactions).toHaveTransaction({ to: pool.address, success: true });
      expect((await pool.getPending(0)).who).toEqualAddress(alice.address); // untouched
    });

    it('a failed adapter report leaves the entry in place', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 1000n);
      await ack(0, false);
      // success=false means the principal never moved: the claim is still owed
      expect((await pool.getPending(0)).who).toEqualAddress(alice.address);
    });

    it('only the adapter can clear a journal entry (401)', async () => {
      pool = await fresh();
      await deposit(1000n, alice.address);
      await pool.sendWithdraw(alice.getSender(), 1000n);
      const r = await ack(0, true, bob.address);
      expect(r.transactions).toHaveTransaction({ to: pool.address, success: false, exitCode: ERR_UNAUTHORIZED });
      expect((await pool.getPending(0)).who).toEqualAddress(alice.address);
    });
  });
});