import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import '@ton/test-utils';
import { readFileSync } from 'fs';
import { resolve } from 'path';

// Opcodes from shared.tolk, duplicated here as the off-chain expectation.
// If these drift from shared.tolk, the parity assertions below fail, which is
// exactly the guard we want on the frozen wire format.
const OP_HARVEST_YIELD = 0x10000033;
const OP_DEPOSIT = 0x10000001;

const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');

async function compileTester(): Promise<Cell> {
  const res = await runTolkCompiler({
    entrypointFileName: 'shared_tester.tolk',
    fsReadCallback: (p) => readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
  });
  if (res.status !== 'ok') throw new Error(res.message);
  return Cell.fromBase64(res.codeBoc64);
}

class Tester implements Contract {
  constructor(
    readonly address: Address,
    readonly init: { code: Cell; data: Cell },
  ) {}

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async getCell(provider: ContractProvider, name: string, stack: any[] = []): Promise<Cell> {
    const r = await provider.get(name, stack as any);
    return r.stack.readCell();
  }
}

describe('C0 shared TL-B layouts', () => {
  let bc: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = await compileTester();
    const init = { code, data: beginCell().endCell() };
    const address = contractAddress(0, init);

    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(address, init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  }, 30000);

  it('PoolConfig packs fields in declaration order', async () => {
    const got = await tester.getCell('packPoolConfig');
    const exp = beginCell()
      .storeUint(86400, 32)
      .storeUint(3600, 32)
      .storeUint(300, 32)
      .storeUint(300, 32)
      .storeUint(1, 16)
      .storeUint(3, 8)
      .storeUint(1500, 16)
      .storeCoins(1_000_000_000)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('DrawResult packs epoch + 256-bit seed', async () => {
    const got = await tester.getCell('packDrawResult');
    const exp = beginCell().storeUint(7, 32).storeUint(123456789, 256).endCell();
    expect(got).toEqualCell(exp);
  });

  it('AdapterReport packs coins as varuint and bool as one bit', async () => {
    const got = await tester.getCell('packAdapterReport');
    const exp = beginCell()
      .storeUint(OP_HARVEST_YIELD, 32)
      .storeCoins(5)
      .storeCoins(2)
      .storeBit(true)
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('DepositPayload packs op + address', async () => {
    const addr = deployer.address;
    const got = await tester.getCell('packDepositPayload', [
      { type: 'slice', cell: beginCell().storeAddress(addr).endCell() },
    ]);
    const exp = beginCell().storeUint(OP_DEPOSIT, 32).storeAddress(addr).endCell();
    expect(got).toEqualCell(exp);
  });
});