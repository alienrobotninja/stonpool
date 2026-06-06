import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { loadCode } from './helpers';

// draw-engine ops
const OP_RUN_DRAW = 0x10000013;
const OP_COMMIT = 0x10000011;
const OP_REVEAL = 0x10000012;
const OP_FINALIZE = 0x10000015;
// selection tester op
const OP_ADD_ENTRY = 0x7e570001;

const T0 = 2_000_000;
const COMMIT_WINDOW = 300;
const REVEAL_WINDOW = 300;
const BOND = 1_000_000_000n;
const EPOCH = 10;
const MIN_HOLD = 2; // eligible if joinEpoch <= 8

const intArg = (n: bigint) => ({ type: 'int' as const, value: n });
const h256 = (c: Cell): bigint => BigInt('0x' + c.hash().toString('hex'));
const commitHashOf = (secret: bigint) => h256(beginCell().storeUint(secret, 256).endCell());
const mixSeed = (seed: bigint, secret: bigint) => h256(beginCell().storeUint(seed, 256).storeUint(secret, 256).endCell());
const tierWord = (seed: bigint, tier: number) => h256(beginCell().storeUint(seed, 256).storeUint(tier, 32).endCell());

class Selection implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() });
  }
  async sendAddEntry(p: ContractProvider, via: Sender, who: Address, weight: bigint, joinEpoch: number) {
    await p.internal(via, {
      value: 50_000_000n,
      body: beginCell().storeUint(OP_ADD_ENTRY, 32).storeUint(0, 64).storeAddress(who).storeCoins(weight).storeUint(joinEpoch, 32).endCell(),
    });
  }
  async getOrder(p: ContractProvider): Promise<Address[]> {
    const t = (await p.get('get_order', [])).stack.readTuple();
    const out: Address[] = [];
    while (t.remaining > 0) out.push(t.readAddress());
    return out;
  }
  async getWinners(p: ContractProvider, seed: bigint, tierCount: number): Promise<Address[]> {
    const t = (await p.get('select_winners', [intArg(seed), intArg(BigInt(tierCount))])).stack.readTuple();
    const out: Address[] = [];
    while (t.remaining > 0) out.push(t.readAddress());
    return out;
  }
}

class Draw implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() });
  }
  async sendStart(p: ContractProvider, via: Sender, epoch: number) {
    await p.internal(via, { value: 100_000_000n, body: beginCell().storeUint(OP_RUN_DRAW, 32).storeUint(0, 64).storeUint(epoch, 32).endCell() });
  }
  async sendCommit(p: ContractProvider, via: Sender, h: bigint) {
    await p.internal(via, { value: BOND, body: beginCell().storeUint(OP_COMMIT, 32).storeUint(0, 64).storeUint(h, 256).endCell() });
  }
  async sendReveal(p: ContractProvider, via: Sender, secret: bigint) {
    await p.internal(via, { value: 100_000_000n, body: beginCell().storeUint(OP_REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell() });
  }
  async sendFinalize(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 200_000_000n, body: beginCell().storeUint(OP_FINALIZE, 32).storeUint(0, 64).endCell() });
  }
  async getSeed(p: ContractProvider): Promise<bigint> {
    const st = (await p.get('get_draw_state', [])).stack;
    st.readBigNumber(); st.readBigNumber(); st.readBigNumber(); st.readBoolean();
    return st.readBigNumber();
  }
}

// independent off-chain rerun of selectWinnerEx across tiers (sampling without replacement)
function offchainWinners(order: Address[], info: Map<string, { w: bigint; elig: boolean }>, seed: bigint, tiers: number): string[] {
  const chosen = new Set<string>();
  const winners: string[] = [];
  for (let t = 0; t < tiers; t++) {
    const word = tierWord(seed, t);
    let total = 0n;
    for (const a of order) { const i = info.get(a.toString())!; if (i.elig && !chosen.has(a.toString())) total += i.w; }
    const target = word % total;
    let cum = 0n, pick = '';
    for (const a of order) {
      const k = a.toString(); const i = info.get(k)!;
      if (i.elig && !chosen.has(k)) { cum += i.w; if (cum > target) { pick = k; break; } }
    }
    winners.push(pick); chosen.add(pick);
  }
  return winners;
}

describe('Draw-to-selection e2e: commit-reveal seed -> tiered distinct selection', () => {
  let bc: Blockchain;
  let poolCore: SandboxContract<TreasuryContract>;
  let alice: SandboxContract<TreasuryContract>;
  let bob: SandboxContract<TreasuryContract>;
  let sel: SandboxContract<Selection>;
  let draw: SandboxContract<Draw>;

  // skewed pool: a whale + mids + a small one (all eligible) + one min-hold failure
  const SA = 0xa11ce0n;
  const SB = 0xb0b0n;
  let depositors: { addr: Address; w: bigint; joinEpoch: number }[];
  let info: Map<string, { w: bigint; elig: boolean }>;

  beforeAll(async () => {
    bc = await Blockchain.create();
    bc.now = T0;
    poolCore = await bc.treasury('poolCore');
    alice = await bc.treasury('alice');
    bob = await bc.treasury('bob');

    // selection ledger
    const selInit = { code: loadCode('selection_tester'), data: beginCell().storeUint(EPOCH, 32).storeUint(MIN_HOLD, 16).storeBit(false).endCell() };
    sel = bc.openContract(new Selection(contractAddress(0, selInit), selInit));
    await sel.sendDeploy(poolCore.getSender());

    depositors = [
      { addr: randomAddress(0), w: 1000n, joinEpoch: 4 }, // whale, eligible
      { addr: randomAddress(0), w: 300n, joinEpoch: 5 },  // eligible
      { addr: randomAddress(0), w: 150n, joinEpoch: 6 },  // eligible
      { addr: randomAddress(0), w: 50n, joinEpoch: 8 },   // eligible (boundary: 10-8>=2)
      { addr: randomAddress(0), w: 500n, joinEpoch: 10 }, // min-hold FAIL (joined this epoch)
    ];
    info = new Map();
    for (const d of depositors) {
      await sel.sendAddEntry(poolCore.getSender(), d.addr, d.w, d.joinEpoch);
      info.set(d.addr.toString(), { w: d.w, elig: EPOCH - d.joinEpoch >= MIN_HOLD });
    }

    // draw engine
    const drawInit = {
      code: loadCode('draw_engine'),
      data: beginCell().storeAddress(poolCore.address).storeUint(0, 32)
        .storeUint(COMMIT_WINDOW, 32).storeUint(REVEAL_WINDOW, 32).storeCoins(BOND)
        .storeUint(0, 32).storeUint(0, 32).storeBit(false).storeUint(0, 256).storeBit(false).endCell(),
    };
    draw = bc.openContract(new Draw(contractAddress(0, drawInit), drawInit));
    await draw.sendDeploy(poolCore.getSender());
  });

  let seed: bigint;
  let winners: Address[];

  it('runs a full draw cycle and finalizes the verifiable seed', async () => {
    await draw.sendStart(poolCore.getSender(), EPOCH);
    await draw.sendCommit(alice.getSender(), commitHashOf(SA));
    await draw.sendCommit(bob.getSender(), commitHashOf(SB));
    bc.now = T0 + COMMIT_WINDOW;
    await draw.sendReveal(alice.getSender(), SA);
    await draw.sendReveal(bob.getSender(), SB);
    bc.now = T0 + COMMIT_WINDOW + REVEAL_WINDOW;
    await draw.sendFinalize(poolCore.getSender());
    seed = await draw.getSeed();
    expect(seed).toBe(mixSeed(mixSeed(0n, SA), SB)); // reproducible from published secrets
  });

  it('selects 3 distinct winners from the finalized seed', async () => {
    winners = await sel.getWinners(seed, 3);
    expect(winners).toHaveLength(3);
    const set = new Set(winners.map((w) => w.toString()));
    expect(set.size).toBe(3); // sampling without replacement
  });

  it('every winner is an eligible participant; the min-hold failure never wins', async () => {
    const eligible = new Set(depositors.filter((d) => EPOCH - d.joinEpoch >= MIN_HOLD).map((d) => d.addr.toString()));
    const ineligible = depositors[4].addr.toString();
    for (const w of winners) expect(eligible.has(w.toString())).toBe(true);
    expect(winners.map((w) => w.toString())).not.toContain(ineligible);
  });

  it('winners are reproducible off-chain from the seed and participant set', async () => {
    const order = await sel.getOrder();
    const expected = offchainWinners(order, info, seed, 3);
    expect(winners.map((w) => w.toString())).toEqual(expected);
  });

  it('selection is deterministic: same seed yields the same winners', async () => {
    const again = await sel.getWinners(seed, 3);
    expect(again.map((w) => w.toString())).toEqual(winners.map((w) => w.toString()));
  });
});