import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, beginCell, contractAddress, Contract, ContractProvider, Sender, Address } from '@ton/core';
import { runTolkCompiler } from '@ton/tolk-js';
import '@ton/test-utils';
import { randomAddress } from '@ton/test-utils';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const OP_JETTON_TRANSFER = 0x0f8a7ea5;
const OP_EXCESSES = 0xd53276db;
const CONTRACTS_DIR = resolve(__dirname, '..', 'contracts');

async function compile(entry: string): Promise<Cell> {
  const res = await runTolkCompiler({
    entrypointFileName: entry,
    fsReadCallback: (p) => readFileSync(resolve(CONTRACTS_DIR, p), 'utf-8'),
  });
  if (res.status !== 'ok') throw new Error(res.message);
  return Cell.fromBase64(res.codeBoc64);
}

function expectedTransfer(dest: Address, resp: Address): Cell {
  return beginCell()
    .storeUint(OP_JETTON_TRANSFER, 32)
    .storeUint(1, 64)
    .storeCoins(100)
    .storeAddress(dest)
    .storeAddress(resp)
    .storeMaybeRef(null)
    .storeCoins(0)
    .storeMaybeRef(null)
    .endCell();
}

class Tester implements Contract {
  constructor(readonly address: Address, readonly init: { code: Cell; data: Cell }) {}
  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
  async sendTrigger(provider: ContractProvider, via: Sender, jw: Address, dest: Address, resp: Address) {
    await provider.internal(via, {
      value: 200_000_000n,
      body: beginCell().storeUint(0x1, 32).storeAddress(jw).storeAddress(dest).storeAddress(resp).endCell(),
    });
  }
  async sendExcessesTrigger(provider: ContractProvider, via: Sender, to: Address) {
    await provider.internal(via, {
      value: 200_000_000n,
      body: beginCell().storeUint(0x2, 32).storeAddress(to).endCell(),
    });
  }
  async getCell(provider: ContractProvider, name: string, stack: any[] = []): Promise<Cell> {
    return (await provider.get(name, stack as any)).stack.readCell();
  }
}

describe('messaging primitives', () => {
  let bc: Blockchain;
  let deployer: SandboxContract<TreasuryContract>;
  let tester: SandboxContract<Tester>;

  beforeAll(async () => {
    const code = await compile('messaging_tester.tolk');
    const init = { code, data: beginCell().endCell() };
    bc = await Blockchain.create();
    deployer = await bc.treasury('deployer');
    tester = bc.openContract(new Tester(contractAddress(0, init), init));
    await tester.sendDeploy(deployer.getSender(), 1_000_000_000n);
  }, 30000);

  const addrSlice = (a: Address) => ({ type: 'slice' as const, cell: beginCell().storeAddress(a).endCell() });

  it('JettonTransfer struct serializes to canonical TEP-74 body', async () => {
    const dest = deployer.address;
    const resp = deployer.address;
    const got = await tester.getCell('packJettonTransfer', [addrSlice(dest), addrSlice(resp)]);
    expect(got).toEqualCell(expectedTransfer(dest, resp));
  });

  it('sendJettonTransfer emits the canonical body to the jetton wallet', async () => {
    const jw = randomAddress();
    const dest = deployer.address;
    const resp = deployer.address;
    const res = await tester.sendTrigger(deployer.getSender(), jw, dest, resp);
    expect(res.transactions).toHaveTransaction({
      from: tester.address,
      to: jw,
      body: expectedTransfer(dest, resp),
    });
  });

  it('JettonTransfer packs present custom/forward payloads as refs', async () => {
    const dest = deployer.address;
    const resp = deployer.address;
    const got = await tester.getCell('packJettonTransferFull', [addrSlice(dest), addrSlice(resp)]);
    const exp = beginCell()
      .storeUint(OP_JETTON_TRANSFER, 32).storeUint(1, 64).storeCoins(100)
      .storeAddress(dest).storeAddress(resp)
      .storeMaybeRef(beginCell().storeUint(0xab, 8).endCell())
      .storeCoins(5)
      .storeMaybeRef(beginCell().storeUint(0xcd, 8).endCell())
      .endCell();
    expect(got).toEqualCell(exp);
  });

  it('sendExcesses emits a JettonExcesses body to the target', async () => {
    const to = randomAddress();
    const res = await tester.sendExcessesTrigger(deployer.getSender(), to);
    expect(res.transactions).toHaveTransaction({ from: tester.address, to, op: OP_EXCESSES });
  });
});