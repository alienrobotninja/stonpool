import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, toNano,
} from '@ton/core';
import { OP } from './protocol';

export function mockStonfiPoolData(admin: Address, walletCode: Cell): Cell {
  return beginCell().storeAddress(admin).storeAddress(null).storeCoins(0).storeCoins(0).storeRef(walletCode).endCell();
}

export class MockStonfiPool implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(admin: Address, walletCode: Cell, code: Cell, workchain = 0) {
    const init = { code, data: mockStonfiPoolData(admin, walletCode) };
    return new MockStonfiPool(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendConfigure(provider: ContractProvider, via: Sender, router: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.CFG_POOL, 32).storeUint(0, 64).storeAddress(router).endCell(),
    });
  }

  // demo-only: credits the pool reserve with extra underlying so harvest has yield to release
  async sendAccrue(provider: ContractProvider, via: Sender, amount: bigint) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.ACCRUE, 32).storeUint(0, 64).storeCoins(amount).endCell(),
    });
  }

  async getPoolData(provider: ContractProvider) {
    const s = (await provider.get('get_pool_data', [])).stack;
    s.readAddress(); s.readAddressOpt();
    return { reserve: s.readBigNumber(), lpSupply: s.readBigNumber() };
  }
}