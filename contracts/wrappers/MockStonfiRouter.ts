import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, toNano,
} from '@ton/core';
import { OP } from './protocol';

export function mockStonfiRouterData(admin: Address): Cell {
  return beginCell().storeAddress(admin).storeAddress(null).storeAddress(null).endCell();
}

export class MockStonfiRouter implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(admin: Address, code: Cell, workchain = 0) {
    const init = { code, data: mockStonfiRouterData(admin) };
    return new MockStonfiRouter(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendConfigure(provider: ContractProvider, via: Sender, routerWallet: Address, stonfiPool: Address) {
    await provider.internal(via, {
      value: toNano('0.1'),
      body: beginCell().storeUint(OP.CFG_ROUTER, 32).storeUint(0, 64).storeAddress(routerWallet).storeAddress(stonfiPool).endCell(),
    });
  }
}