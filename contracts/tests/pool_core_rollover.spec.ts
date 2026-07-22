import { Blockchain, SandboxContract, TreasuryContract, internal } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { loadCode } from './helpers';
import { PoolConfig } from '../wrappers/protocol';
import { poolCoreData } from '../wrappers/PoolCore';

const OP_TRANSFER_NOTIFICATION = 0x7362d09c;
const OP_VAULT_CREDIT = 0x10000006;
const OP_DRAW_RESULT = 0x10000014;
const OP_ADVANCE_EPOCH = 0x10000004;
const OP_CONFIGURE_CORE = 0x10000073;

const ROLE_JETTON_WALLET = 0, ROLE_ADAPTER = 1, ROLE_DRAW_ENGINE = 2, ROLE_VAULT = 3;

const T0 = 2_000_000;
const JOIN = 5;

// minHold 1 is the lever: a deposit is ineligible in its own epoch and only becomes
// eligible one boundary later, which is how these tests force the eligible==0 branch of
// DrawResultMsg while the pot is funded. pool_core_payout only ever draws with eligible
// depositors, so the rollover path (pot retained, nobody paid) is otherwise uncovered.
const CFG: PoolConfig = { epochLength: 3600, depositCutoff: 600, commitWindow: 900, revealWindow: 900, minHoldEpochs: 1, prizeTiers: 3, skimBps: 1000, drawBond: 1_000_000_000n };

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
}

function decodePayout(body: Cell): { to: Address; amount: bigint } {
  const s = body.beginParse();
  s.loadUint(32); s.loadUint(64);
  return { to: s.loadAddress(), amount: s.loadCoins() };
}

describe('C1 pool-core prize-pot rollover across epochs', () => {
  let bc: Blockchain;
  let code: Cell;
  let admin: SandboxContract<TreasuryContract>;
  let jw: SandboxContract<TreasuryContract>;
  let adapter: SandboxContract<TreasuryContract>;
  let drawEngine: SandboxContract<TreasuryContract>;
  let vault: SandboxContract<TreasuryContract>;
  let depositors: SandboxContract<TreasuryContract>[];
  let pool: SandboxContract<Pool>;

  beforeAll(() => { code = loadCode('pool_core'); });

  // Deploy at currentEpoch = JOIN and wire the four roles as treasury stubs, but do NOT
  // advance: each test drives the boundary itself so it can land a draw while the ledger
  // is still ineligible. Deposits enter at JOIN with distinct weights.
  async function deploy(numDeps: number): Promise<void> {
    bc = await Blockchain.create();
    bc.now = T0;
    admin = await bc.treasury('admin');
    jw = await bc.treasury('jw');
    adapter = await bc.treasury('adapter');
    drawEngine = await bc.treasury('drawEngine');
    vault = await bc.treasury('vault');
    depositors = [];
    for (let i = 0; i < numDeps; i++) depositors.push(await bc.treasury('dep' + i));

    const init = { code, data: poolCoreData({ epoch: JOIN, genesis: T0, admin: admin.address, config: CFG, depositDeadline: T0 + 100_000 }) };
    pool = bc.openContract(new Pool(contractAddress(0, init), init));
    await pool.sendDeploy(admin.getSender());
    await pool.sendConfigure(admin.getSender(), ROLE_JETTON_WALLET, jw.address);
    await pool.sendConfigure(admin.getSender(), ROLE_ADAPTER, adapter.address);
    await pool.sendConfigure(admin.getSender(), ROLE_DRAW_ENGINE, drawEngine.address);
    await pool.sendConfigure(admin.getSender(), ROLE_VAULT, vault.address);

    for (let i = 0; i < numDeps; i++) {
      const b = beginCell().storeUint(OP_TRANSFER_NOTIFICATION, 32).storeUint(0, 64).storeCoins(BigInt((i + 1) * 1000)).storeAddress(depositors[i].address).endCell();
      await bc.sendMessage(internal({ from: jw.address, to: pool.address, value: 300_000_000n, body: b }));
    }
  }

  const credit = (amount: bigint) =>
    bc.sendMessage(internal({ from: vault.address, to: pool.address, value: 100_000_000n, body: beginCell().storeUint(OP_VAULT_CREDIT, 32).storeUint(0, 64).storeCoins(amount).endCell() }));

  // drawOpen is not required here: the handler clears it unconditionally, then branches
  // on eligibility. The epoch field is informational (selection reads currentEpoch).
  const deliverDraw = (epoch: number, seed: bigint) =>
    bc.sendMessage(internal({ from: drawEngine.address, to: pool.address, value: 1_500_000_000n, body: beginCell().storeUint(OP_DRAW_RESULT, 32).storeUint(0, 64).storeUint(epoch, 32).storeUint(seed, 256).endCell() }));

  const payoutsOf = (r: any): { to: Address; amount: bigint }[] =>
    r.transactions
      .flatMap((tx: any) => Array.from(tx.outMessages.values()))
      .filter((m: any) => m.info?.dest && m.info.dest.equals(vault.address) && m.body)
      .map((m: any) => decodePayout(m.body));

  it('a draw with no eligible depositor rolls the pot over and pays nobody', async () => {
    await deploy(0); // empty ledger -> eligible == 0
    await credit(10_000n);
    expect((await pool.getData()).prizePot).toBe(10_000n);

    const r = await deliverDraw(JOIN, 0xfeedn);
    expect(r.transactions).toHaveTransaction({ to: pool.address, from: drawEngine.address, success: true });
    // the eligible==0 branch returns before the skim/tier sends: not even skim goes out
    expect(payoutsOf(r)).toHaveLength(0);
    // and the pot is untouched, carried to the next draw
    expect((await pool.getData()).prizePot).toBe(10_000n);
  });

  it('the rolled-over pot is distributed by the next eligible draw across the boundary', async () => {
    await deploy(4); // deposits at JOIN; at currentEpoch JOIN they are held 0 -> ineligible
    const POT = 10_000n;
    await credit(POT);

    // draw while still in the join epoch: eligible == 0, pot rolls over untouched
    const r1 = await deliverDraw(JOIN, 0x1n);
    expect(payoutsOf(r1)).toHaveLength(0);
    expect((await pool.getData()).prizePot).toBe(POT);

    // cross the boundary. advance arms a fresh draw and fires a harvest at the adapter
    // stub (swallowed, no VaultCredit), so the pot must still read the rolled-over value.
    bc.now = T0 + CFG.epochLength;
    await pool.sendAdvance(admin.getSender());
    expect((await pool.getData()).epoch).toBe(BigInt(JOIN + 1));
    expect((await pool.getData()).prizePot).toBe(POT); // rollover survived the advance + harvest

    // depositors are now held 1 epoch -> eligible. the accumulated pot distributes in full.
    const r2 = await deliverDraw(JOIN + 1, 0x2n);
    const payouts = payoutsOf(r2);
    const skim = (POT * BigInt(CFG.skimBps)) / 10000n;
    const tierPays = payouts.filter((p) => !p.to.equals(admin.address));
    expect(payouts.find((p) => p.to.equals(admin.address))?.amount).toBe(skim);
    expect(tierPays).toHaveLength(CFG.prizeTiers);
    expect(new Set(tierPays.map((p) => p.to.toString())).size).toBe(CFG.prizeTiers); // distinct winners
    expect(tierPays.reduce((a, p) => a + p.amount, 0n)).toBe(POT - skim);            // the rolled-over pot, in full
    expect((await pool.getData()).prizePot).toBe(0n);
  });

  it('successive rollovers compound the pot', async () => {
    await deploy(0);
    await credit(1_000n);
    await deliverDraw(JOIN, 0xa1n);           // eligible 0 -> rollover
    expect((await pool.getData()).prizePot).toBe(1_000n);

    await credit(500n);                        // a later harvest lands on top of the carried pot
    await deliverDraw(JOIN, 0xa2n);           // eligible 0 -> rollover again
    expect((await pool.getData()).prizePot).toBe(1_500n);
  });
});