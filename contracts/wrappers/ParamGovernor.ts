import {
  Address, beginCell, Cell, Contract, contractAddress, ContractProvider, Sender,
} from '@ton/core';
import { packConfig, PoolConfig } from './protocol';

export type ParamGovernorConfig = {
  admin: Address;
  poolCore: Address;
  timelockDelay: number;
  config: PoolConfig;
};

export function paramGovernorData(c: ParamGovernorConfig): Cell {
  return beginCell()
    .storeAddress(c.admin)
    .storeAddress(c.poolCore)
    .storeUint(c.timelockDelay, 32)
    .storeUint(0, 32)
    .storeRef(packConfig(c.config))
    .storeMaybeRef(null)
    .endCell();
}

export class ParamGovernor implements Contract {
  constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

  static createFromConfig(cfg: ParamGovernorConfig, code: Cell, workchain = 0) {
    const init = { code, data: paramGovernorData(cfg) };
    return new ParamGovernor(contractAddress(workchain, init), init);
  }

  async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
    await provider.internal(via, { value, body: beginCell().endCell() });
  }
}