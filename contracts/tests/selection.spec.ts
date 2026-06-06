import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { loadCode } from './helpers';

const OP_ADD_ENTRY = 0x7e570001;
const ERR_NO_DEPOSITORS = 422;
const EPOCH = 5;
const MIN_HOLD = 1;

const addrArg = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });
const intArg = (n: bigint) => ({ type: 'int' as const, value: n });

class Ledger implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(p: ContractProvider, via: Sender) {
    await p.internal(via, { value: 1_000_000_000n, body: beginCell().endCell() });
  }
  async sendAddEntry(p: ContractProvider, via: Sender, who: Address, weight: bigint, joinEpoch: number) {
    await p.internal(via, {
      value: 100_000_000n,
      body: beginCell().storeUint(OP_ADD_ENTRY, 32).storeUint(0, 64).storeAddress(who).storeCoins(weight).storeUint(joinEpoch, 32).endCell(),
    });
  }
  async getCount(p: ContractProvider): Promise<bigint> {
    return (await p.get('get_participant_count', [])).stack.readBigNumber();
  }
  async getTotalWeight(p: ContractProvider): Promise<bigint> {
    return (await p.get('get_total_weight', [])).stack.readBigNumber();
  }
  async getOdds(p: ContractProvider, who: Address): Promise<bigint> {
    return (await p.get('get_odds', [addrArg(who)])).stack.readBigNumber();
  }
  async getWinner(p: ContractProvider, word: bigint): Promise<Address> {
    return (await p.get('preview_winner', [intArg(word)])).stack.readAddress();
  }
  async getWinnerFlat(p: ContractProvider, word: bigint): Promise<Address> {
    return (await p.get('preview_winner_flat', [intArg(word)])).stack.readAddress();
  }
  async getTierWord(p: ContractProvider, seed: bigint, tier: number): Promise<bigint> {
    return (await p.get('tier_word', [intArg(seed), intArg(BigInt(tier))])).stack.readBigNumber();
  }
}

function ledgerData(epoch: number, minHold: number): Cell {
  return beginCell().storeUint(epoch, 32).storeUint(minHold, 16).storeBit(false).endCell();
}

describe('C2 selection ledger', () => {
  let bc: Blockchain;
  let code: Cell;
  let deployer: SandboxContract<TreasuryContract>;
  let A: Address, B: Address, C: Address, D: Address;

  beforeAll(() => { code = loadCode('selection_tester'); });

  async function fresh(): Promise<SandboxContract<Ledger>> {
    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    const init = { code, data: ledgerData(EPOCH, MIN_HOLD) };
    const led = bc.openContract(new Ledger(contractAddress(0, init), init));
    await led.sendDeploy(deployer.getSender());
    return led;
  }

  // weighted pool: A=2, B=3, C=5 eligible (joined epoch 3, held 2 >= 1); D ineligible (joined this epoch)
  async function seeded(): Promise<SandboxContract<Ledger>> {
    const led = await fresh();
    A = randomAddress(0); B = randomAddress(0); C = randomAddress(0); D = randomAddress(0);
    await led.sendAddEntry(deployer.getSender(), A, 2n, 3);
    await led.sendAddEntry(deployer.getSender(), B, 3n, 3);
    await led.sendAddEntry(deployer.getSender(), C, 5n, 3);
    await led.sendAddEntry(deployer.getSender(), D, 7n, EPOCH); // held 0 epochs -> ineligible
    return led;
  }

  const match = (got: Address) => [A, B, C, D].findIndex((x) => x.equals(got));

  it('participant_count counts all entries', async () => {
    const led = await seeded();
    expect(await led.getCount()).toBe(4n);
  });

  it('total_weight is the eligible weight only (excludes min-hold failures)', async () => {
    const led = await seeded();
    expect(await led.getTotalWeight()).toBe(10n); // 2+3+5, D excluded
  });

  it('weighted selection maps each residue exactly once, proportional to weight', async () => {
    const led = await seeded();
    const tally = [0, 0, 0, 0];
    for (let w = 0; w < 10; w++) tally[match(await led.getWinner(BigInt(w)))]++;
    expect(tally).toEqual([2, 3, 5, 0]); // A=2, B=3, C=5, D never
  });

  it('flat mode gives each eligible entry one ticket', async () => {
    const led = await seeded();
    const tally = [0, 0, 0, 0];
    for (let w = 0; w < 3; w++) tally[match(await led.getWinnerFlat(BigInt(w)))]++;
    expect(tally).toEqual([1, 1, 1, 0]);
  });

  it('odds are weight/total in bps, 0 for ineligible', async () => {
    const led = await seeded();
    expect(await led.getOdds(A)).toBe(2000n); // 2/10
    expect(await led.getOdds(C)).toBe(5000n); // 5/10
    expect(await led.getOdds(D)).toBe(0n);    // min-hold not met
  });

  it('an empty (or all-ineligible) ledger reverts NO_DEPOSITORS (422)', async () => {
    const led = await fresh();
    await expect(led.getWinner(0n)).rejects.toThrow();
    // and with only an ineligible entry:
    const only = randomAddress(0);
    await led.sendAddEntry(deployer.getSender(), only, 5n, EPOCH);
    await expect(led.getWinner(0n)).rejects.toThrow();
  });

  it('tier_word = hash(seed || tier), reproducible off-chain and distinct per tier', async () => {
    const led = await fresh();
    const seed = 0xfeed1234n;
    const h = (t: number) => BigInt('0x' + beginCell().storeUint(seed, 256).storeUint(t, 32).endCell().hash().toString('hex'));
    const w0 = await led.getTierWord(seed, 0);
    const w1 = await led.getTierWord(seed, 1);
    expect(w0).toBe(h(0));
    expect(w1).toBe(h(1));
    expect(w0).not.toBe(w1);
  });

});