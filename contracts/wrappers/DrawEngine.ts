import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender, toNano,
} from '@ton/core';
import { OP } from './protocol';

export type DrawEngineConfig = {
  poolCore: Address;
  commitWindow: number;
  revealWindow: number;
  drawBond: bigint;
};

export function drawEngineData(c: DrawEngineConfig): Cell {
  return beginCell()
    .storeAddress(c.poolCore)
    .storeUint(0, 32)
    .storeUint(c.commitWindow, 32)
    .storeUint(c.revealWindow, 32)
    .storeCoins(c.drawBond)
    .storeUint(0, 32)
    .storeUint(0, 32)
    .storeBit(false)
    .storeUint(0, 256)
    .storeBit(false)
    .endCell();
}

export class DrawEngine implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(cfg: DrawEngineConfig, code: Cell, workchain = 0) {
    const init = { code, data: drawEngineData(cfg) };
    return new DrawEngine(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }

  async sendCommit(provider: ContractProvider, via: Sender, commitHash: bigint, value: bigint) {
    await provider.internal(via, {
      value,
      body: beginCell().storeUint(OP.COMMIT, 32).storeUint(0, 64).storeUint(commitHash, 256).endCell(),
    });
  }

  async sendReveal(provider: ContractProvider, via: Sender, secret: bigint, value = toNano('0.2')) {
    await provider.internal(via, {
      value,
      body: beginCell().storeUint(OP.REVEAL, 32).storeUint(0, 64).storeUint(secret, 256).endCell(),
    });
  }
}